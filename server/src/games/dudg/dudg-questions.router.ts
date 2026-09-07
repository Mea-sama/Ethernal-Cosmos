import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { requireAuth } from '../../auth/auth.middleware';
import {
  listQuestionMeta,
  slugifyFilename,
  customQuestionsDir,
  isSafeFilename,
} from './dudg-questions.util';

const MAX_UPLOAD_BYTES = 64 * 1024; // 64 KB — plenty for a markdown question, blocks abuse

const FormSchema = z.object({
  mode: z.literal('form'),
  title: z.string().min(1).max(300),
  moderatorNotes: z.string().max(2000).optional().default(''),
  media: z.string().max(500).optional().default(''),
  hint1: z.string().max(1000).optional().default(''),
  hint2: z.string().max(1000).optional().default(''),
  answer: z.string().max(500).optional().default(''),
  options: z.string().max(1000).optional().default(''),
  rank: z.string().max(100).optional().default(''),
  labels: z.array(z.string().min(1).max(32)).min(1).max(10),
});

const RawSchema = z.object({
  mode: z.literal('raw'),
  filename: z.string().min(1).max(80),
  rawMarkdown: z.string().min(1).max(MAX_UPLOAD_BYTES),
  labels: z.array(z.string().min(1).max(32)).min(1).max(10).optional(),
});

const BodySchema = z.union([FormSchema, RawSchema]);

function renderFormToMarkdown(data: z.infer<typeof FormSchema>): string {
  const lines: string[] = [`# ${data.title}`];
  if (data.moderatorNotes.trim()) lines.push('', data.moderatorNotes.trim());
  lines.push('', '## Media', '', data.media.trim());
  if (data.options.trim()) lines.push('', '## Options', '', data.options.trim());
  if (data.rank.trim()) lines.push('', '## Rank', '', data.rank.trim());
  lines.push('', '## Hint 1', '', data.hint1.trim());
  lines.push('', '## Hint 2', '', data.hint2.trim());
  if (data.answer.trim()) lines.push('', '## Answer', '', data.answer.trim());
  lines.push('', '## Labels', '', data.labels.join(', '));
  return lines.join('\n') + '\n';
}

/** Minimal structural validation before persisting a raw upload — must look like a DUDG question file. */
function isWellFormedQuestionMarkdown(raw: string): boolean {
  return /^#(?!#)\s+\S/.test(raw.trim());
}

export const dudgQuestionsRouter = Router();
dudgQuestionsRouter.use(requireAuth);

/** GET /dudg/api/questions — metadata only (filename, title, labels, source), no spoilers */
dudgQuestionsRouter.get('/', (_req, res) => {
  try {
    res.json(listQuestionMeta());
  } catch (err) {
    console.error('[DUDG] GET /questions Fehler:', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

/** POST /dudg/api/questions — add a custom question (structured form or raw .md upload) */
dudgQuestionsRouter.post('/', (req, res): void => {
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  let filenameBase: string;
  let markdown: string;
  let labels: string[];

  if (parsed.data.mode === 'form') {
    filenameBase = slugifyFilename(parsed.data.title);
    markdown = renderFormToMarkdown(parsed.data);
    labels = parsed.data.labels;
  } else {
    filenameBase = slugifyFilename(parsed.data.filename.replace(/\.md$/, ''));
    markdown = parsed.data.rawMarkdown;
    labels = parsed.data.labels ?? ['Custom'];
    if (Buffer.byteLength(markdown, 'utf8') > MAX_UPLOAD_BYTES) {
      res.status(413).json({ error: 'Datei zu groß' });
      return;
    }
    if (!isWellFormedQuestionMarkdown(markdown)) {
      res.status(400).json({ error: 'Ungültiges Frage-Format (muss mit "# Frage" beginnen)' });
      return;
    }
    if (!/(?:^|\n)##\s+Labels/i.test(markdown)) {
      markdown = markdown.trimEnd() + `\n\n## Labels\n\n${labels.join(', ')}\n`;
    }
  }

  const filename = `${filenameBase}.md`;
  if (!isSafeFilename(filename)) {
    res.status(400).json({ error: 'Ungültiger Dateiname' });
    return;
  }

  const dir = customQuestionsDir();
  const filepath = path.join(dir, filename);
  if (fs.existsSync(filepath)) {
    res.status(409).json({ error: 'Eine Frage mit diesem Namen existiert bereits' });
    return;
  }

  try {
    fs.writeFileSync(filepath, markdown, 'utf8');
    res.status(201).json({ ok: true, filename, labels });
  } catch (err) {
    console.error('[DUDG] POST /questions Fehler:', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});
