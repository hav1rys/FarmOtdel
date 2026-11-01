// Бот отдела: по Discord ID узнаёт тег, отображаемое имя и аватар.
// Работает только через REST API Discord с токеном бота. Приглашать бота на сервер
// не нужно: запрос GET /users/{id} доступен боту для любого пользователя.

const API = 'https://discord.com/api/v10';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createDiscordBot(token) {
  const enabled = !!token;

  // { tag, name, avatar } | null, если такого пользователя нет. Бросает ошибку при сбое сети/токена.
  async function lookup(discordId) {
    if (!enabled) throw new Error('Не задан DISCORD_BOT_TOKEN');
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${API}/users/${discordId}`, {
        headers: { Authorization: `Bot ${token}`, 'User-Agent': 'FarmOtdelBot (https://discord.com, 1.0)' },
      });
      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        await sleep(Math.ceil((body.retry_after ?? 1) * 1000) + 100);
        continue;
      }
      if (res.status === 404 || res.status === 400) return null;
      if (res.status === 401) throw new Error('Discord отклонил токен бота (DISCORD_BOT_TOKEN)');
      if (!res.ok) throw new Error(`Discord ответил ${res.status}`);
      const u = await res.json();
      return {
        // У старых аккаунтов и ботов ещё есть #1234
        tag: u.discriminator && u.discriminator !== '0' ? `${u.username}#${u.discriminator}` : u.username,
        name: u.global_name || '',
        avatar: u.avatar || '',
      };
    }
    throw new Error('Discord просит подождать, попробуйте позже');
  }

  return { enabled, lookup };
}
