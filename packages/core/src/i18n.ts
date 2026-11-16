const MESSAGES = {
  "pt-BR": {
    decisionsHeader: "Decisões até agora:",
    noDecisions: "Ainda não registrei nenhuma decisão.",
    actionItemsHeader: "Itens de ação:",
    noActionItems: "Ainda não registrei nenhum item de ação.",
    summaryHeader: "Resumo até agora:",
    noSummary: "Ainda não há o que resumir.",
    owner: "responsável",
    due: "prazo",
    done: "concluído",
    paused: "Pausei a transcrição. Digite 'om continuar' para eu voltar a ouvir.",
    resumed: "Voltei a transcrever.",
    leaving: "Saindo da reunião. Até mais!",
    externalAsk:
      "Entrou alguém de fora da organização, então pausei a transcrição. Alguém da equipe pode digitar 'om continuar' para eu seguir, ou 'om sair' para eu sair.",
    externalLeave: "Entrou alguém de fora da organização, então vou sair da reunião.",
    notAllowed: "Só alguém da organização pode retomar a transcrição.",
    agentUnavailable: "Ainda não consigo fazer isso por aqui.",
    failed: "Não consegui concluir esse pedido.",
    confirmPrefix: "Preciso de confirmação para:",
    confirmHow: "Responda 'om sim' para confirmar ou 'om não' para cancelar.",
    denied: "Ação cancelada: não houve confirmação.",
    fullAnswerInPanel: "(resposta completa no painel)",
  },
  en: {
    decisionsHeader: "Decisions so far:",
    noDecisions: "I have not recorded any decision yet.",
    actionItemsHeader: "Action items:",
    noActionItems: "I have not recorded any action item yet.",
    summaryHeader: "Summary so far:",
    noSummary: "There is nothing to summarize yet.",
    owner: "owner",
    due: "due",
    done: "done",
    paused: "Transcription paused. Type 'om resume' and I will listen again.",
    resumed: "Transcribing again.",
    leaving: "Leaving the meeting. See you!",
    externalAsk:
      "Someone from outside the organization joined, so I paused the transcription. A team member can type 'om resume' to continue, or 'om leave' to send me away.",
    externalLeave: "Someone from outside the organization joined, so I am leaving the meeting.",
    notAllowed: "Only someone from the organization can resume the transcription.",
    agentUnavailable: "I cannot do that from here yet.",
    failed: "I could not complete that request.",
    confirmPrefix: "I need a confirmation for:",
    confirmHow: "Reply 'om yes' to confirm or 'om no' to cancel.",
    denied: "Action cancelled: it was not confirmed.",
    fullAnswerInPanel: "(full answer on the panel)",
  },
} as const;

export type MessageKey = keyof (typeof MESSAGES)["en"];

/** UI strings the agent says by itself (no model involved). Falls back to English. */
export function t(language: string, key: MessageKey): string {
  const table = language.toLowerCase().startsWith("pt") ? MESSAGES["pt-BR"] : MESSAGES.en;
  return table[key];
}
