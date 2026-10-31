'use strict';

const fs = require('fs');
const { OllamaPcError } = require('./errors');
const { loadKnowledge, formatKnowledge, PLACEHOLDER_MARKER } = require('./knowledge');

const CHAT_TEMPLATE_OVERHEAD_TOKENS = 64;
const OMISSION_NOTE_TOKENS = 48;
const ENTRY_OVERHEAD_TOKENS = 8;

function estimateTokens(text, charsPerToken) {
  return Math.ceil(String(text).length / charsPerToken);
}

function readOptional(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

function loadPromptFiles(config) {
  const warnings = [];
  const system = readOptional(config.systemPromptFile);
  if (!system) {
    throw new OllamaPcError('SYSTEM_PROMPT_MISSING', `Systemprompt-Datei fehlt oder ist leer: ${config.systemPromptFile}`);
  }
  if (system.includes(PLACEHOLDER_MARKER)) {
    warnings.push(`Systemprompt enthält noch ${PLACEHOLDER_MARKER}…]-Platzhalter (z. B. Signatur)`);
  }

  let examples = readOptional(config.examplesFile);
  if (examples.includes(PLACEHOLDER_MARKER)) {
    warnings.push(`Beispiel-Antworten werden ignoriert, solange sie ${PLACEHOLDER_MARKER}…]-Platzhalter enthalten`);
    examples = '';
  }

  const knowledgeFiles = loadKnowledge(config.knowledgeDir);
  for (const file of knowledgeFiles) {
    if (file.ignoredLines > 0) {
      warnings.push(`Firmenwissen ${file.name}: ${file.ignoredLines} Zeile(n) mit ${PLACEHOLDER_MARKER}…] ignoriert`);
    }
  }
  const knowledgeBlock = formatKnowledge(knowledgeFiles);
  const knowledgeTokens = knowledgeBlock ? estimateTokens(knowledgeBlock, config.charsPerToken) : 0;
  const knowledgeRatio = knowledgeTokens / config.numCtx;
  if (knowledgeRatio > config.knowledgeWarnRatio) {
    warnings.push(
      `Firmenwissen belegt ca. ${knowledgeTokens} Token (${Math.round(knowledgeRatio * 100)}% von num_ctx ${config.numCtx}, Grenze ${Math.round(config.knowledgeWarnRatio * 100)}%): Wissen kürzen, num_ctx erhöhen oder RAG einsetzen`,
    );
  }

  const parts = [system, examples && `## Beispiel-Antworten\n\n${examples}`, knowledgeBlock].filter(Boolean);
  return {
    system: parts.join('\n\n'),
    warnings,
    knowledge: { files: knowledgeFiles.map((f) => f.name), tokens: knowledgeTokens, ratio: knowledgeRatio },
  };
}

function formatMail({ from, date, subject, text }) {
  const header = [from && `Von: ${from}`, date && `Datum: ${date}`, subject && `Betreff: ${subject}`].filter(Boolean);
  return header.length ? `${header.join('\n')}\n\n${text}` : text;
}

function formatHistoryEntry({ from, date, text }) {
  const label = [date && `[${date}]`, from].filter(Boolean).join(' ');
  return label ? `${label}:\n${text}` : text;
}

function validateInput(input) {
  if (!input || typeof input !== 'object') throw new OllamaPcError('INVALID_INPUT', 'Eingabe muss ein JSON-Objekt sein');
  if (!input.mail || typeof input.mail.text !== 'string' || !input.mail.text.trim()) {
    throw new OllamaPcError('INVALID_INPUT', 'mail.text fehlt oder ist leer');
  }
  if (input.history !== undefined && !Array.isArray(input.history)) {
    throw new OllamaPcError('INVALID_INPUT', 'history muss ein Array sein');
  }
  for (const entry of input.history || []) {
    if (!entry || typeof entry.text !== 'string') throw new OllamaPcError('INVALID_INPUT', 'Jeder history-Eintrag braucht ein Feld text');
  }
}

function buildUserMessage({ context, entries, omitted, mail }) {
  const sections = [];
  if (context && context.trim()) sections.push(`## Zusatzkontext\n\n${context.trim()}`);
  if (entries.length || omitted > 0) {
    const note = omitted > 0 ? `(Hinweis: ${omitted} ältere E-Mail(s) wurden aus Platzgründen weggelassen.)\n\n` : '';
    sections.push(`## E-Mail-Verlauf (chronologisch, älteste zuerst)\n\n${note}${entries.join('\n\n---\n\n')}`);
  }
  sections.push(`## Zu beantwortende E-Mail\n\n${formatMail(mail)}`);
  sections.push('Schreibe jetzt die Antwort auf die letzte E-Mail. Gib ausschließlich den Antworttext aus, ohne Betreffzeile und ohne Erklärungen.');
  return sections.join('\n\n---\n\n');
}

function buildMessages(prompts, input, { numCtx, responseReserveTokens, charsPerToken }) {
  validateInput(input);
  const history = (input.history || []).filter((entry) => entry.text.trim());
  const cpt = charsPerToken;

  const baseUser = buildUserMessage({ context: input.context, entries: [], omitted: 0, mail: input.mail });
  const fixedTokens =
    estimateTokens(prompts.system, cpt) + estimateTokens(baseUser, cpt) + CHAT_TEMPLATE_OVERHEAD_TOKENS + OMISSION_NOTE_TOKENS;
  const available = numCtx - responseReserveTokens - fixedTokens;
  if (available < 0) {
    throw new OllamaPcError(
      'PROMPT_TOO_LARGE',
      `Systemprompt, Zusatzkontext und zu beantwortende Mail benötigen ca. ${fixedTokens} Token, verfügbar sind ${numCtx - responseReserveTokens} (num_ctx ${numCtx} abzüglich ${responseReserveTokens} Reserve). OLLAMA_NUM_CTX erhöhen oder Eingabe kürzen.`,
      { fixedTokens, numCtx, responseReserveTokens },
    );
  }

  const kept = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const formatted = formatHistoryEntry(history[i]);
    const tokens = estimateTokens(formatted, cpt) + ENTRY_OVERHEAD_TOKENS;
    if (used + tokens > available) break;
    used += tokens;
    kept.unshift(formatted);
  }

  const omitted = history.length - kept.length;
  const user = buildUserMessage({ context: input.context, entries: kept, omitted, mail: input.mail });
  const messages = [
    { role: 'system', content: prompts.system },
    { role: 'user', content: user },
  ];
  const warnings = [...prompts.warnings];
  if (omitted > 0) {
    warnings.push(`${omitted} von ${history.length} älteren Mails im Verlauf gekürzt (Budget ${available} Token, num_ctx ${numCtx})`);
  }

  return {
    messages,
    omitted,
    keptHistory: kept.length,
    estimatedTokens: fixedTokens + used,
    totalChars: prompts.system.length + user.length,
    warnings,
  };
}

function cleanReply(text) {
  const trimmed = String(text || '').trim();
  const lines = trimmed.split('\n');
  if (lines.length > 1 && /^\s*(\*\*)?(betreff|subject)\s*:/i.test(lines[0])) {
    return lines.slice(1).join('\n').trim();
  }
  return trimmed;
}

module.exports = { loadPromptFiles, buildMessages, cleanReply, estimateTokens, PLACEHOLDER_MARKER };
