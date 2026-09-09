import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface ZzzRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  idempotencyKey: string | undefined;
  body: string;
}

export interface MockZzz {
  url: string;
  requests: ZzzRequest[];
  answer(status: number, body: unknown): void;
  redirect(location: string): void;
  disconnect(): void;
  stall(): void;
  close(): Promise<void>;
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function startMockZzz(token: string): Promise<MockZzz> {
  const requests: ZzzRequest[] = [];
  let next: { kind: "answer"; status: number; body: unknown; headers?: Record<string, string> } | { kind: "disconnect" } | { kind: "stall" } | null = null;
  const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const body = await bodyOf(request);
    requests.push({
      method: request.method ?? "",
      path: request.url ?? "",
      authorization: request.headers.authorization,
      idempotencyKey: request.headers["idempotency-key"] as string | undefined,
      body,
    });
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end('{"error":{"code":"invalid_credentials"}}');
      return;
    }
    if (next !== null) {
      const answer = next;
      next = null;
      if (answer.kind === "disconnect") { request.socket.destroy(); return; }
      if (answer.kind === "stall") return;
      response.writeHead(answer.status, { "Content-Type": "application/json", ...answer.headers });
      response.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
      return;
    }
    if (request.method === "GET" && request.url === "/api/v1/rooms") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"items":[]}');
      return;
    }
    const reply = request.url?.includes("/posts") === true;
    response.writeHead(201, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: `${reply ? "pst" : "thr"}_${"a".repeat(32)}`, replayed: false }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("mock did not bind TCP");
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
    answer(status, body) { next = { kind: "answer", status, body }; },
    redirect(location) { next = { kind: "answer", status: 302, body: "", headers: { Location: location } }; },
    disconnect() { next = { kind: "disconnect" }; },
    stall() { next = { kind: "stall" }; },
    async close() { await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); },
  };
}
