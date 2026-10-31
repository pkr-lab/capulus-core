'use strict';

function cell(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
}

function seconds(ms) {
  return (ms / 1000).toFixed(1);
}

function resultsTable(rows) {
  const header = '| Modell | Mail | GPU-Anteil | Gesamtdauer (s) | prompt_eval (s) | Prompt-Token | eval_count | Token/s | Hinweise |';
  const divider = '|---|---|---|---|---|---|---|---|---|';
  const lines = rows.map((row) => {
    if (row.error) {
      return `| ${cell(row.model)} | ${cell(row.mail)} | ${row.gpu_percent}% | – | – | – | – | – | Fehler: ${cell(row.error)} |`;
    }
    const s = row.stats;
    return `| ${cell(row.model)} | ${cell(row.mail)} | ${row.gpu_percent}% | ${seconds(row.wall_ms)} | ${seconds(s.prompt_eval_duration_ms)} | ${s.prompt_eval_count} | ${s.eval_count} | ${s.tokens_per_second} | ${cell(row.warnings.join('; '))} |`;
  });
  return [header, divider, ...lines].join('\n');
}

function psTable(entries) {
  const header = '| Modell | Größe (GB) | davon VRAM (GB) | GPU-Anteil | Kontext |';
  const divider = '|---|---|---|---|---|';
  const gb = (bytes) => (bytes / 1024 ** 3).toFixed(1);
  const lines = entries.map(
    (m) => `| ${cell(m.model)} | ${gb(m.size)} | ${gb(m.size_vram)} | ${m.gpu_percent}% | ${m.context_length || ''} |`,
  );
  return [header, divider, ...lines].join('\n');
}

function comparison(models, mails, rows) {
  const sections = mails.map((mail) => {
    const byModel = models.map((model) => rows.find((r) => r.model === model && r.mail === mail.name));
    const head = `| ${models.map(cell).join(' | ')} |`;
    const divider = `|${models.map(() => '---').join('|')}|`;
    const answers = `| ${byModel.map((r) => (r && r.error ? `Fehler: ${cell(r.error)}` : cell(r && r.reply))).join(' | ')} |`;
    return `## ${mail.name}\n\n${head}\n${divider}\n${answers}`;
  });
  return sections.join('\n\n---\n\n');
}

module.exports = { resultsTable, psTable, comparison, cell };
