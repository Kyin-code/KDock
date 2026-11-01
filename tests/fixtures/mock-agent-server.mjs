import { createServer } from "node:http";

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url.includes("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const messages = body.messages || [];
  const users = messages.filter((m) => m.role === "user").map((m) => String(m.content || ""));
  const lastUser = users.at(-1) || "";
  const toolResults = messages
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content || ""));
  const spawned = toolResults
    .map((text) => text.match(/子会话\s+(s[0-9A-Za-z-]+)/)?.[1])
    .find(Boolean);

  let delta;
  let finish = "stop";
  if (lastUser.includes("PARENT_TASK") && toolResults.length === 0) {
    finish = "tool_calls";
    delta = {
      tool_calls: [{
        index: 0,
        id: "mock_call_1",
        type: "function",
        function: {
          name: "subagent_spawn",
          arguments: JSON.stringify({
            title: "Mock child",
            task: "CHILD_TASK: reply exactly child-ok",
          }),
        },
      }],
    };
  } else if (lastUser.includes("PARENT_TASK") && toolResults.length === 1 && spawned) {
    finish = "tool_calls";
    delta = {
      tool_calls: [{
        index: 0,
        id: "mock_call_2",
        type: "function",
        function: {
          name: "subagent_wait",
          arguments: JSON.stringify({ session: spawned, timeout_ms: 5000 }),
        },
      }],
    };
  } else if (lastUser.includes("PARENT_TASK") && toolResults.length === 2 && spawned) {
    finish = "tool_calls";
    delta = {
      tool_calls: [{
        index: 0,
        id: "mock_call_3",
        type: "function",
        function: {
          name: "subagent_result",
          arguments: JSON.stringify({ session: spawned }),
        },
      }],
    };
  } else if (lastUser.includes("CHILD_TASK")) {
    delta = { content: "child-ok" };
  } else if (toolResults.length > 0 || lastUser.includes("PARENT_TASK")) {
    delta = { content: "parent-done" };
  } else {
    delta = { content: "mock-ok" };
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
  });
  const chunk = {
    id: "chatcmpl-mock",
    model: "mock-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write(`data: ${JSON.stringify({
    id: "chatcmpl-mock",
    model: "mock-model",
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })}\n\n`);
  res.end("data: [DONE]\n\n");
});

server.listen(9460, "127.0.0.1");
