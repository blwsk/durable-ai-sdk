'use client';

import { useChat } from '@ai-sdk/react';
import { WorkflowChatTransport } from '@ai-sdk/workflow/client';
import { lastAssistantMessageIsCompleteWithApprovalResponses } from 'ai';
import { useMemo, useState } from 'react';

export default function Page() {
  const [runId, setRunId] = useState<string>();
  const transport = useMemo(
    () =>
      new WorkflowChatTransport({
        api: '/api/chat',
        // Send the chat id so the server can link this conversation's turns.
        prepareSendMessagesRequest: ({ id, messages }) => ({
          body: { id, messages },
        }),
        onChatSendMessage: (response) =>
          setRunId(response.headers.get('x-workflow-run-id') ?? undefined),
      }),
    [],
  );
  const { messages, sendMessage, addToolApprovalResponse, status, error } =
    useChat({
      transport,
      // Answering an approval request starts the next turn by itself.
      sendAutomaticallyWhen:
        lastAssistantMessageIsCompleteWithApprovalResponses,
    });
  const [input, setInput] = useState('');
  const busy = status === 'submitted' || status === 'streaming';

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: 16 }}>
      <h1 style={{ fontSize: 16 }}>Durable agent</h1>
      {runId && <p style={{ color: '#666' }}>workflow run: {runId}</p>}

      {messages.map((message) => (
        <div key={message.id} style={{ margin: '12px 0' }}>
          <strong>{message.role}</strong>
          {message.parts.map((part, index) => {
            if (part.type === 'text') {
              return (
                <div key={index} style={{ whiteSpace: 'pre-wrap' }}>
                  {part.text}
                </div>
              );
            }
            if (part.type.startsWith('tool-')) {
              const tool = part as {
                type: string;
                state: string;
                input?: unknown;
                output?: unknown;
                errorText?: string;
                approval?: { id: string; approved?: boolean };
              };
              const name = tool.type.slice('tool-'.length);
              if (tool.state === 'approval-requested' && tool.approval) {
                const { id } = tool.approval;
                return (
                  <div
                    key={index}
                    style={{
                      border: '1px solid #c80',
                      padding: 8,
                      margin: '4px 0',
                    }}
                  >
                    <div>
                      Allow <strong>{name}</strong> {JSON.stringify(tool.input)}
                      ?
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        addToolApprovalResponse({ id, approved: true })
                      }
                      style={{ font: 'inherit', marginRight: 8 }}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        addToolApprovalResponse({ id, approved: false })
                      }
                      style={{ font: 'inherit' }}
                    >
                      Deny
                    </button>
                  </div>
                );
              }
              return (
                <details key={index} style={{ color: '#555' }}>
                  <summary>
                    {name} · {tool.state}
                  </summary>
                  <pre style={{ overflowX: 'auto', fontSize: 12 }}>
                    {JSON.stringify(
                      {
                        input: tool.input,
                        output: tool.output,
                        error: tool.errorText,
                        approval: tool.approval,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              );
            }
            return null;
          })}
        </div>
      ))}

      {error && <p style={{ color: 'crimson' }}>{error.message}</p>}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!input.trim() || busy) return;
          sendMessage({ text: input });
          setInput('');
        }}
        style={{ display: 'flex', gap: 8, marginTop: 16 }}
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask about weather, notes, or have code written and run…"
          style={{ flex: 1, padding: 8, font: 'inherit' }}
        />
        <button type="submit" disabled={busy} style={{ font: 'inherit' }}>
          {busy ? '…' : 'Send'}
        </button>
      </form>
    </main>
  );
}
