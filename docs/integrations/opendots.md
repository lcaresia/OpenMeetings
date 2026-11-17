# Integração com o OpenDots

O OpenDots (CopilotKit, licença MIT) cria "colegas de trabalho de IA", os Dots, que conversam
por texto, chamadas e Slack. O Open Meetings entra como o especialista em reuniões: entra na
chamada do Meet, mantém as notas estruturadas, escreve a ata e lembra das reuniões anteriores.
O Dot orquestra e conversa com as pessoas. A fronteira está na ADR
[0006](../decisions/0006-opendots-boundary.md).

## Como os dois se conectam

| Caminho                        | Para quê                                                      | Onde         |
| ------------------------------ | ------------------------------------------------------------- | ------------ |
| Servidor MCP (Streamable HTTP) | O Dot chama ferramentas: entrar, perguntar, ler notas, buscar | `POST /mcp`  |
| AG-UI (SSE)                    | Acompanhar a reunião ao vivo: estado, transcrição, respostas  | `POST /agui` |

A extensão documentada do OpenDots são servidores MCP remotos, então o caminho principal é o
`/mcp`. O stream AG-UI serve para quem quer o detalhe ao vivo (o `relay.mjs` do exemplo usa).

## Passo a passo

1. Suba o Open Meetings e anote o endereço e o token:

   ```bash
   docker compose up -d
   ```

   O servidor precisa ser alcançável a partir do OpenDots. Se o OpenDots roda em outra
   máquina, publique o Open Meetings com HTTPS (veja [deploy em VPS](../deploy-vps.md)) e
   defina `OM_AUTH_TOKEN`.

2. No OpenDots, adicione um servidor MCP remoto:

   | Campo     | Valor                                   |
   | --------- | --------------------------------------- |
   | Nome      | `open-meetings`                         |
   | URL       | `https://reunioes.suaempresa.com/mcp`   |
   | Cabeçalho | `Authorization: Bearer <OM_AUTH_TOKEN>` |

3. Crie um Dot chamado "Meeting Dot" com as instruções de
   [`examples/opendots-dot/meeting-dot.md`](../../examples/opendots-dot/meeting-dot.md) e dê a
   ele o servidor `open-meetings`.

4. No thread do Dot, peça: "entra na reunião https://meet.google.com/abc-defg-hij". O Dot chama
   `join_meeting`, o bot entra e se anuncia no chat da chamada; o anfitrião precisa admitir o
   bot.

5. Durante a reunião, pergunte ao Dot "o que já foi decidido?" (`ask_meeting`). Quando a
   reunião acabar, o Dot lê a ata (`get_meeting`) e posta no thread.

6. Opcional, Slack ao vivo: rode o relay, que segue a reunião por AG-UI e posta cada decisão e
   item de ação no canal:

   ```bash
   OM_URL=https://reunioes.suaempresa.com OM_TOKEN=... SLACK_WEBHOOK_URL=https://hooks.slack.com/... MEETING_ID=<id> node examples/opendots-dot/relay.mjs
   ```

## Ferramentas MCP

| Ferramenta                           | Faz                                                         |
| ------------------------------------ | ----------------------------------------------------------- |
| `join_meeting(url, title?)`          | Manda o bot para a reunião; devolve o id e o link do painel |
| `list_meetings(limit?)`              | Reuniões recentes, ao vivo e passadas                       |
| `get_meeting(meeting_id)`            | Status, decisões, itens de ação, perguntas, resumo e ata    |
| `ask_meeting(question, meeting_id?)` | Pergunta à reunião ao vivo, ou ao histórico                 |
| `search_meetings(query, limit?)`     | Busca por significado em todas as reuniões                  |
| `leave_meeting(meeting_id)`          | Tira o bot da reunião (a ata é escrita na saída)            |

## Usando o AG-UI direto

Qualquer cliente AG-UI (por exemplo `HttpAgent` de `@ag-ui/client`) segue uma reunião:

```ts
import { HttpAgent } from "@ag-ui/client";

const agent = new HttpAgent({ url: "http://localhost:4319/agui", threadId: meetingId });
await agent.runAgent(
  {},
  {
    onStateChanged: ({ state }) => console.log(state.decisions),
    onCustomEvent: ({ event }) => event.name === "om.transcript" && console.log(event.value.text),
  },
);
```

`threadId` é o id da reunião; com `forwardedProps: { meetingUrl }` o mesmo run inicia uma
reunião nova. O mapeamento completo dos eventos está na ADR
[0005](../decisions/0005-agui-mapping.md). Confirmações de ações externas chegam como
interrupção AG-UI (`RUN_FINISHED` com `outcome.type = "interrupt"`), e o cliente responde com
`resume`, então a UI de aprovação do CopilotKit funciona sem código extra.

## O que foi verificado

- O contrato AG-UI é testado no CI com o `HttpAgent` oficial: o estado reconstruído só com
  `STATE_SNAPSHOT` + `STATE_DELTA` é idêntico ao do servidor.
- O servidor MCP é testado no CI com o cliente oficial do SDK MCP (Streamable HTTP).
- Não testado: o fluxo dentro de uma instalação real do OpenDots. A tela exata para adicionar
  um servidor MCP pode mudar entre versões do OpenDots.
