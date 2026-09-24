import { describe, it, expect } from 'vitest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { DiscordApiClient, DiscordApiError } from './discord-api.client';

/**
 * 用**真实的本地 HTTP 服务器**测试客户端，而不是 mock fetch。
 * mock fetch 只能证明「我们按预期调用了它」，证明不了请求行、鉴权头、
 * 超时与错误分类这些真正会出错的地方。
 */
interface Recorded {
  method: string;
  url: string;
  auth: string | undefined;
  body: string;
}

async function withServer(
  handler: (req: any, res: any) => void,
  fn: (base: string, records: Recorded[]) => Promise<void>,
) {
  const records: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: any) => (raw += c));
    req.on('end', () => {
      records.push({
        method: req.method || '',
        url: req.url || '',
        auth: req.headers['authorization'],
        body: raw,
      });
      handler(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`, records);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

// 测试期间把 API 基址指向本地服务器
const originalBase = 'https://discord.com/api/v10';

describe('DiscordApiClient', () => {
  it('sendMessage 用 POST 到正确的频道路径，并带 Bot 鉴权头', async () => {
    await withServer(
      (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg-123' }));
      },
      async (base, records) => {
        // 通过覆写全局 fetch 把请求导向本地服务器，同时保留真实请求语义
        const realFetch = globalThis.fetch;
        globalThis.fetch = ((input: any, init: any) => {
          const url = String(input).replace(originalBase, base);
          return realFetch(url, init);
        }) as any;
        try {
          const client = new DiscordApiClient('TEST_TOKEN');
          const id = await client.sendMessage('CHAN', { content: 'hello' });
          expect(id).toBe('msg-123');
          expect(records[0].method).toBe('POST');
          expect(records[0].url).toBe('/channels/CHAN/messages');
          expect(records[0].auth).toBe('Bot TEST_TOKEN');
          expect(JSON.parse(records[0].body).content).toBe('hello');
        } finally {
          globalThis.fetch = realFetch;
        }
      },
    );
  });

  it('editMessage 用 PATCH 到消息路径', async () => {
    await withServer(
      (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg-123' }));
      },
      async (base, records) => {
        const realFetch = globalThis.fetch;
        globalThis.fetch = ((input: any, init: any) =>
          realFetch(String(input).replace(originalBase, base), init)) as any;
        try {
          const client = new DiscordApiClient('T');
          await client.editMessage('C1', 'M1', { content: 'edited' });
          expect(records[0].method).toBe('PATCH');
          expect(records[0].url).toBe('/channels/C1/messages/M1');
          expect(JSON.parse(records[0].body).content).toBe('edited');
        } finally {
          globalThis.fetch = realFetch;
        }
      },
    );
  });

  it('频道 ID 与消息 ID 被 URL 编码，避免注入额外路径段', async () => {
    await withServer(
      (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'x' }));
      },
      async (base, records) => {
        const realFetch = globalThis.fetch;
        globalThis.fetch = ((input: any, init: any) =>
          realFetch(String(input).replace(originalBase, base), init)) as any;
        try {
          const client = new DiscordApiClient('T');
          await client.sendMessage('a/../b', { content: 'x' });
          expect(records[0].url).toBe('/channels/a%2F..%2Fb/messages');
          expect(records[0].url).not.toContain('/../');
        } finally {
          globalThis.fetch = realFetch;
        }
      },
    );
  });

  it('429 与 5xx 判定为可重试，4xx 不可重试', async () => {
    const cases: Array<[number, boolean]> = [
      [429, true],
      [500, true],
      [503, true],
      [400, false],
      [401, false],
      [403, false],
      [404, false],
    ];
    for (const [status, retryable] of cases) {
      await withServer(
        (req, res) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 0, message: 'x' }));
        },
        async (base) => {
          const realFetch = globalThis.fetch;
          globalThis.fetch = ((input: any, init: any) =>
            realFetch(String(input).replace(originalBase, base), init)) as any;
          try {
            const client = new DiscordApiClient('T');
            let caught: any;
            try {
              await client.sendMessage('C', { content: 'x' });
            } catch (e) {
              caught = e;
            }
            expect(caught).toBeInstanceOf(DiscordApiError);
            expect(caught.retryable).toBe(retryable);
            expect(caught.status).toBe(status);
          } finally {
            globalThis.fetch = realFetch;
          }
        },
      );
    }
  });

  it('响应不是 JSON 时按 5xx 可重试、4xx 不可重试分类', async () => {
    for (const [status, retryable] of [[500, true], [400, false]] as Array<[number, boolean]>) {
      await withServer(
        (req, res) => {
          res.writeHead(status, { 'Content-Type': 'text/html' });
          res.end('<html>oops</html>');
        },
        async (base) => {
          const realFetch = globalThis.fetch;
          globalThis.fetch = ((input: any, init: any) =>
            realFetch(String(input).replace(originalBase, base), init)) as any;
          try {
            const client = new DiscordApiClient('T');
            let caught: any;
            try {
              await client.sendMessage('C', { content: 'x' });
            } catch (e) {
              caught = e;
            }
            expect(caught).toBeInstanceOf(DiscordApiError);
            expect(caught.retryable).toBe(retryable);
          } finally {
            globalThis.fetch = realFetch;
          }
        },
      );
    }
  });

  it('204 无响应体时不抛错（编辑类接口的常见返回）', async () => {
    await withServer(
      (req, res) => {
        res.writeHead(204);
        res.end();
      },
      async (base) => {
        const realFetch = globalThis.fetch;
        globalThis.fetch = ((input: any, init: any) =>
          realFetch(String(input).replace(originalBase, base), init)) as any;
        try {
          const client = new DiscordApiClient('T');
          await expect(client.editMessage('C', 'M', { content: 'x' })).resolves.toBeUndefined();
        } finally {
          globalThis.fetch = realFetch;
        }
      },
    );
  });

  it('网络失败被包装成可重试错误，且不回显 token', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error('boom'))) as any;
    try {
      const client = new DiscordApiClient('SUPER_SECRET_TOKEN');
      let caught: any;
      try {
        await client.sendMessage('C', { content: 'x' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(DiscordApiError);
      expect(caught.retryable).toBe(true);
      expect(caught.message).not.toContain('SUPER_SECRET_TOKEN');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('错误分类不依赖响应体里的 message（只记 code 与 status）', async () => {
    await withServer(
      (req, res) => {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 50001, message: 'Missing Access' }));
      },
      async (base) => {
        const realFetch = globalThis.fetch;
        globalThis.fetch = ((input: any, init: any) =>
          realFetch(String(input).replace(originalBase, base), init)) as any;
        try {
          const client = new DiscordApiClient('T');
          let caught: any;
          try {
            await client.sendMessage('C', { content: 'x' });
          } catch (e) {
            caught = e;
          }
          expect(caught.retryable).toBe(false);
          expect(caught.status).toBe(403);
        } finally {
          globalThis.fetch = realFetch;
        }
      },
    );
  });
});
