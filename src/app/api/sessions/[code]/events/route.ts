import { getSessionByCode, buildSessionState, publicState } from "@/lib/quiz";
import { subscribe } from "@/lib/pubsub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  const { code } = await context.params;
  const session = await getSessionByCode(code);
  if (!session) {
    return new Response("Not found", { status: 404 });
  }

  // Host token only via header — never query string (access logs).
  const hostToken = request.headers.get("x-host-token") ?? "";
  const isHost = Boolean(hostToken && hostToken === session.host_token);

  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: string) => {
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };

      const initial = await buildSessionState(code, { revealAnswer: isHost });
      if (initial) {
        send(
          JSON.stringify({
            type: "state",
            state: isHost ? initial : publicState(initial),
          }),
        );
      }

      cleanup = subscribe(code, (payload) => {
        try {
          const parsed = JSON.parse(payload) as {
            type: string;
            state?: ReturnType<typeof publicState>;
          };
          if (parsed.type === "state" && parsed.state && !isHost) {
            send(
              JSON.stringify({
                type: "state",
                state: publicState(parsed.state),
              }),
            );
          } else {
            send(payload);
          }
        } catch {
          send(payload);
        }
      });

      const ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          clearInterval(ping);
        }
      }, 15000);

      const abort = () => {
        clearInterval(ping);
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      request.signal.addEventListener("abort", abort);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
