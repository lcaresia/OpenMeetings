# Integração com o OpenBot

O OpenBot é um app de desktop que roda agentes como um time persistente na máquina. Ele aceita
qualquer agente que fale ACP (Agent Client Protocol) e qualquer endpoint compatível com a API
da OpenAI. O Open Meetings oferece os dois.

Licença: o OpenBot é distribuído sob PolyForm Noncommercial 1.0.0 (source-available, não open
source no sentido OSI). O Open Meetings não copia nem deriva código dele; a integração é só por
protocolo.

## Opção 1: agente ACP (`om acp`)

`om acp` fala JSON-RPC pela entrada e saída padrão e repassa para um `om serve` em execução.

1. Suba o servidor (`om serve` ou `docker compose up`).
2. No OpenBot, adicione um agente ACP personalizado:

   | Campo      | Valor                                                  |
   | ---------- | ------------------------------------------------------ |
   | Comando    | `npx`                                                  |
   | Argumentos | `-y open-meetings acp --server http://localhost:4319`  |
   | Variáveis  | `OM_AUTH_TOKEN=<token>` (só se o servidor tiver token) |

   Com o repositório clonado: comando `node`, argumentos
   `apps/server/dist/main.js acp --server http://localhost:4319`.

3. Abra uma sessão com o agente e use:

   | Você escreve                              | O que acontece                                                                          |
   | ----------------------------------------- | --------------------------------------------------------------------------------------- |
   | Um link do Meet                           | O bot entra; decisões e itens de ação chegam como mensagens enquanto a reunião acontece |
   | "quais os itens de ação?"                 | Responde pela reunião ao vivo                                                           |
   | "o que ficou pendente da semana passada?" | Responde pelas reuniões salvas                                                          |
   | "me manda a ata"                          | Depois que a reunião acaba, devolve a ata                                               |

## Opção 2: endpoint compatível com OpenAI

1. No OpenBot, adicione um provedor compatível com OpenAI:

   | Campo    | Valor                                                         |
   | -------- | ------------------------------------------------------------- |
   | Base URL | `http://localhost:4319/v1`                                    |
   | Chave    | o token do servidor, ou qualquer texto se ele não tiver token |
   | Modelo   | `open-meetings/live` ou `open-meetings/history`               |

2. `open-meetings/live` responde pela reunião em andamento (a mais recente, ou a indicada em
   `meeting_id` no corpo da requisição). `open-meetings/history` responde sobre reuniões
   passadas, com busca semântica quando há motor de embeddings.

O mesmo endpoint funciona com qualquer cliente que aceite uma base URL da OpenAI.

## Delegar do meio da reunião para agentes ACP

O caminho inverso também existe: na reunião alguém diz "open meetings, pede pro agente de
código abrir uma issue com esse bug" e o Open Meetings repassa a tarefa para um agente ACP
externo (OpenCode, Claude Code, Codex, Gemini CLI). Configure em `tools.acp_agents`:

```yaml
tools:
  acp_agents:
    - name: codigo
      command: opencode
      args: ["acp"]
      autoApprove: false
```

Cada agente vira uma ferramenta `agent_<nome>`. Como toda ação com efeito fora da reunião, a
delegação pede confirmação no chat (`om sim`) ou no painel, salvo com `autoApprove: true`.
Depois de confirmada, pedidos de permissão do próprio agente são respondidos "permitir uma vez".

## O que foi verificado

- `om acp` é testado no CI com o SDK oficial do ACP (`@agentclientprotocol/sdk` 2.7): handshake,
  sessão e a pergunta "quais os itens de ação?" sobre uma reunião.
- O endpoint `/v1` é testado no CI com o SDK oficial `openai`, com e sem streaming.
- A delegação é testada contra um agente ACP de teste que pede permissão.
- Não testado: o cadastro dentro de uma instalação real do OpenBot; os nomes dos campos podem
  variar entre versões.
