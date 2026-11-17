import { createContext, useContext } from "react";

const pt = {
  appName: "Open Meetings",
  navMeetings: "Reuniões",
  navSettings: "Configurações",
  sendBot: "Enviar bot para reunião",
  sendBotHint:
    "Cole o link do Google Meet. O bot entra como participante, se anuncia e começa a transcrever.",
  meetingLink: "Link da reunião",
  meetingTitle: "Título (opcional)",
  send: "Enviar",
  sending: "Enviando...",
  liveNow: "Ao vivo",
  history: "Histórico",
  noMeetings: "Nenhuma reunião ainda.",
  searchPlaceholder: "Buscar em todas as reuniões (por significado)",
  search: "Buscar",
  noResults: "Nada encontrado.",
  searchOff: "A busca semântica precisa de um motor de embeddings configurado.",
  status_joining: "entrando",
  status_live: "ao vivo",
  status_ended: "encerrada",
  status_failed: "falhou",
  status_paused: "pausado",
  status_left: "encerrada",
  transcript: "Transcrição",
  waitingSpeech: "Aguardando falas...",
  decisions: "Decisões",
  actionItems: "Itens de ação",
  openQuestions: "Perguntas em aberto",
  summary: "Resumo",
  none: "Nada ainda.",
  owner: "Responsável",
  due: "Prazo",
  goToQuote: "Ir para o trecho",
  commandPlaceholder: "Peça algo ao agente: resumo, cronograma, planilha...",
  ask: "Pedir",
  agentWorking: "O agente está trabalhando...",
  cost: "Custo",
  latency: "Resposta",
  leave: "Tirar o bot da reunião",
  leaveConfirm: "Tirar o bot da reunião agora?",
  deleteMeeting: "Apagar reunião",
  deleteConfirm: "Apagar esta reunião, a transcrição, a ata e os artefatos? Não dá para desfazer.",
  approvalTitle: "Confirmação necessária",
  approve: "Confirmar",
  deny: "Cancelar",
  minutes: "Ata",
  minutesPending: "A ata é escrita quando a reunião termina.",
  exportMd: "Baixar .md",
  exportDocx: "Baixar .docx",
  exportPdf: "Imprimir / PDF",
  exportCsv: "Baixar .csv",
  exportXlsx: "Baixar .xlsx",
  exportExcalidraw: "Abrir no Excalidraw (.excalidraw)",
  save: "Salvar",
  saved: "Salvo",
  addRow: "Adicionar linha",
  conversation: "Conversa com o agente",
  participants: "Participantes",
  settings: "Configurações",
  activeConfig: "Configuração ativa (segredos ocultos)",
  runDoctor: "Rodar om doctor",
  doctorRunning: "Testando os motores...",
  tokenTitle: "Acesso",
  tokenHint:
    "Este servidor pede um token. Ele está em OM_AUTH_TOKEN (ou server.authToken no config).",
  token: "Token",
  enter: "Entrar",
  connectionLost: "Conexão perdida, reconectando...",
  error: "Erro",
  back: "Voltar",
  externalBadge: "externo",
  language: "Idioma",
};

export type Messages = typeof pt;

const en: Messages = {
  appName: "Open Meetings",
  navMeetings: "Meetings",
  navSettings: "Settings",
  sendBot: "Send the bot to a meeting",
  sendBotHint:
    "Paste the Google Meet link. The bot joins as a participant, introduces itself and starts transcribing.",
  meetingLink: "Meeting link",
  meetingTitle: "Title (optional)",
  send: "Send",
  sending: "Sending...",
  liveNow: "Live",
  history: "History",
  noMeetings: "No meetings yet.",
  searchPlaceholder: "Search every meeting (by meaning)",
  search: "Search",
  noResults: "Nothing found.",
  searchOff: "Semantic search needs an embeddings engine in the config.",
  status_joining: "joining",
  status_live: "live",
  status_ended: "ended",
  status_failed: "failed",
  status_paused: "paused",
  status_left: "ended",
  transcript: "Transcript",
  waitingSpeech: "Waiting for someone to speak...",
  decisions: "Decisions",
  actionItems: "Action items",
  openQuestions: "Open questions",
  summary: "Summary",
  none: "Nothing yet.",
  owner: "Owner",
  due: "Due",
  goToQuote: "Go to the quote",
  commandPlaceholder: "Ask the agent: summary, timeline, spreadsheet...",
  ask: "Ask",
  agentWorking: "The agent is working...",
  cost: "Cost",
  latency: "Response",
  leave: "Take the bot out",
  leaveConfirm: "Take the bot out of the meeting now?",
  deleteMeeting: "Delete meeting",
  deleteConfirm:
    "Delete this meeting, its transcript, minutes and artifacts? This cannot be undone.",
  approvalTitle: "Confirmation needed",
  approve: "Confirm",
  deny: "Cancel",
  minutes: "Minutes",
  minutesPending: "The minutes are written when the meeting ends.",
  exportMd: "Download .md",
  exportDocx: "Download .docx",
  exportPdf: "Print / PDF",
  exportCsv: "Download .csv",
  exportXlsx: "Download .xlsx",
  exportExcalidraw: "Open in Excalidraw (.excalidraw)",
  save: "Save",
  saved: "Saved",
  addRow: "Add row",
  conversation: "Conversation with the agent",
  participants: "Participants",
  settings: "Settings",
  activeConfig: "Active config (secrets hidden)",
  runDoctor: "Run om doctor",
  doctorRunning: "Testing the engines...",
  tokenTitle: "Access",
  tokenHint:
    "This server needs a token. It is in OM_AUTH_TOKEN (or server.authToken in the config).",
  token: "Token",
  enter: "Enter",
  connectionLost: "Connection lost, reconnecting...",
  error: "Error",
  back: "Back",
  externalBadge: "external",
  language: "Language",
};

export const LANGUAGES = { "pt-BR": pt, en } as const;
export type Language = keyof typeof LANGUAGES;

export function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem("om.lang");
    if (saved === "pt-BR" || saved === "en") return saved;
  } catch {
    // storage blocked: fall through
  }
  return navigator.language.toLowerCase().startsWith("pt") ? "pt-BR" : "en";
}

export const I18nContext = createContext<{
  t: Messages;
  lang: Language;
  setLang: (lang: Language) => void;
}>({
  t: pt,
  lang: "pt-BR",
  setLang: () => undefined,
});

export const useI18n = () => useContext(I18nContext);
