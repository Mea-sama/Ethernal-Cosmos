import fs from 'fs';
import path from 'path';
import MarkdownIt from 'markdown-it';
import type { Question, QuestionMeta, QuestionOption } from './types';

const md = new MarkdownIt({ html: true, linkify: true });

const BASIC_DIR = path.resolve(__dirname, '../questions');
const CUSTOM_DIR = path.resolve(__dirname, '../customQuestions');

const AUDIO_EXT = /\.(mp3|wav|ogg|aac|flac|m4a)(\?.*)?$/i;

function resolveMediaSrc(raw: string): string {
  if (!raw || /^https?:\/\//i.test(raw) || raw.startsWith('/')) return raw;
  // Media files are copied into the client's static /dudg/media folder — see games/dudg/client/media.
  const base = raw.replace(/^\.\.\//, '').replace(/^(images|audio)\//, '$1/');
  return `/dudg/media/${base}`;
}

/** Rewrites any inline `images/...`/`audio/...` src refs left over from rendered markdown (e.g. inside hint bodies) to the new /dudg/media/ mount. */
function rewriteMediaUrls(html: string): string;
function rewriteMediaUrls(html: string | null): string | null;
function rewriteMediaUrls(html: string | null): string | null {
  if (!html) return html;
  return html.replace(/(src|href)=("|')(?:\.\.\/)?(images|audio)\/([^"']+)\2/g, `$1=$2/dudg/media/$3/$4$2`);
}

function dirFor(source: 'basic' | 'custom'): string {
  return source === 'basic' ? BASIC_DIR : CUSTOM_DIR;
}

function ensureDirs(): void {
  fs.mkdirSync(BASIC_DIR, { recursive: true });
  fs.mkdirSync(CUSTOM_DIR, { recursive: true });
}

/** Parses the DUDG section-based markdown question format (adds a "## Labels" section). */
export function parseQuestion(filename: string, raw: string): Question {
  const sections: Record<string, string> = {};
  let currentKey: string | null = null;
  let buf: string[] = [];
  for (const line of raw.split('\n')) {
    const h1m = line.match(/^#(?!#)\s+(.*)/);
    const h2m = line.match(/^##\s+(.*)/);
    if (h1m) {
      if (currentKey !== null) sections[currentKey] = buf.join('\n').trim();
      currentKey = '__question__';
      buf = [h1m[1].trim()];
    } else if (h2m) {
      if (currentKey !== null) sections[currentKey] = buf.join('\n').trim();
      currentKey = h2m[1].trim().toLowerCase();
      buf = [];
    } else if (currentKey !== null) {
      buf.push(line);
    }
  }
  if (currentKey !== null) sections[currentKey] = buf.join('\n').trim();

  const qLines = (sections['__question__'] || '').split('\n');
  const questionMd = qLines[0] || '';
  const moderatorMd = qLines.slice(1).join('\n').trim();

  const questionHtml = md.render(questionMd);
  const questionText = questionMd;
  const moderatorHtml = moderatorMd ? md.render(moderatorMd) : null;

  const mediaMd = sections['media'] || null;
  let mediaHtml: string | null = null;
  let audioSrc: string | null = null;
  if (mediaMd) {
    const bare = mediaMd.trim();
    const mdAudio = bare.match(/^!\[[^\]]*\]\(([^)]+)\)$/);
    if (mdAudio && AUDIO_EXT.test(mdAudio[1])) {
      audioSrc = resolveMediaSrc(mdAudio[1]);
    } else if (!bare.includes(' ') && AUDIO_EXT.test(bare)) {
      audioSrc = resolveMediaSrc(bare);
    } else if (/^<audio\b/i.test(bare)) {
      const srcMatch = bare.match(/\bsrc=["']([^"']+)["']/i);
      if (srcMatch) audioSrc = resolveMediaSrc(srcMatch[1]);
    } else if (/youtu\.?be/.test(bare)) {
      const m = bare.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
      if (m) mediaHtml = `<iframe width="100%" height="400" src="https://www.youtube.com/embed/${m[1]}" frameborder="0" allowfullscreen style="border-radius:8px;max-height:60vh"></iframe>`;
    } else if (/vimeo\.com/.test(bare)) {
      const m = bare.match(/vimeo\.com\/(\d+)/);
      if (m) mediaHtml = `<iframe width="100%" height="400" src="https://player.vimeo.com/video/${m[1]}" frameborder="0" allowfullscreen style="border-radius:8px;max-height:60vh"></iframe>`;
    } else {
      mediaHtml = md.render(mediaMd);
    }
  }

  const hint1Raw = sections['hint 1'] || null;
  const hint2Raw = sections['hint 2'] || null;

  const optionsMd = sections['options'] || null;
  let options: QuestionOption[] | null = null;
  if (optionsMd) {
    const parsed: QuestionOption[] = [];
    for (const line of optionsMd.split('\n')) {
      const m = line.match(/^([A-F]):\s*(.*)/);
      if (m) {
        const rawLine = m[2].trim();
        const pipIdx = rawLine.indexOf(' | ');
        const text = pipIdx >= 0 ? rawLine.slice(0, pipIdx).trim() : rawLine;
        const value = pipIdx >= 0 ? rawLine.slice(pipIdx + 3).trim() : null;
        parsed.push({
          letter: m[1],
          text,
          html: rewriteMediaUrls(text ? md.renderInline(text) : ''),
          value,
          valueHtml: rewriteMediaUrls(value ? md.renderInline(value) : null),
        });
      }
    }
    if (parsed.length > 0) options = parsed;
  }

  const rankMd = sections['rank'] || null;
  let optionRank: string[] | null = null;
  if (rankMd && options) {
    optionRank = rankMd
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((l) => /^[A-F]$/.test(l));
    if (optionRank.length === 0) optionRank = null;
  }

  const answerRaw = sections['answer'] || null;
  const resolvedAnswer = options
    ? answerRaw
      ? answerRaw.trim()
      : optionRank
        ? optionRank[0]
        : null
    : answerRaw
      ? answerRaw.trim()
      : null;

  const labelsRaw = sections['labels'] || null;
  const labels = labelsRaw
    ? labelsRaw
        .split(/[,\n]/)
        .map((l) => l.trim())
        .filter(Boolean)
    : ['Basic'];

  return {
    filename,
    questionHtml: rewriteMediaUrls(questionHtml),
    questionText,
    moderatorHtml: rewriteMediaUrls(moderatorHtml),
    mediaHtml: rewriteMediaUrls(mediaHtml),
    audioSrc,
    hint1: hint1Raw,
    hint2: hint2Raw,
    hint1Html: rewriteMediaUrls(hint1Raw ? md.render(hint1Raw) : null),
    hint2Html: rewriteMediaUrls(hint2Raw ? md.render(hint2Raw) : null),
    answer: resolvedAnswer,
    answerHtml: rewriteMediaUrls(resolvedAnswer ? md.render(resolvedAnswer) : null),
    options,
    optionRank,
    questionType: options ? 'options' : 'standard',
    labels: labels.length > 0 ? labels : ['Basic'],
  };
}

/** Lists metadata (title + labels) for every question in both folders — no spoilers. */
export function listQuestionMeta(): QuestionMeta[] {
  ensureDirs();
  const out: QuestionMeta[] = [];
  for (const source of ['basic', 'custom'] as const) {
    const dir = dirFor(source);
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_'));
    } catch {
      files = [];
    }
    for (const filename of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, filename), 'utf8');
        const q = parseQuestion(filename, raw);
        out.push({ filename, title: q.questionText, labels: q.labels, source });
      } catch {
        // skip unreadable/malformed files
      }
    }
  }
  return out.sort((a, b) => a.filename.localeCompare(b.filename));
}

/** Loads full question content (answer/hints/media included) by filename, checking both folders. */
export function loadQuestionByFilename(filename: string): Question {
  for (const source of ['basic', 'custom'] as const) {
    const filepath = path.join(dirFor(source), filename);
    if (fs.existsSync(filepath)) {
      return parseQuestion(filename, fs.readFileSync(filepath, 'utf8'));
    }
  }
  throw new Error(`QUESTION_NOT_FOUND: ${filename}`);
}

// ─── Custom question submission (used by the Hub's REST router, not the subprocess) ──

const FILENAME_SAFE = /^[a-z0-9_-]+$/i;

export function slugifyFilename(base: string): string {
  const slug = base
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 64);
  return slug || `question_${Date.now()}`;
}

export function customQuestionsDir(): string {
  ensureDirs();
  return CUSTOM_DIR;
}

export function isSafeFilename(filename: string): boolean {
  const name = filename.replace(/\.md$/, '');
  return FILENAME_SAFE.test(name) && !filename.includes('..') && !filename.includes('/') && !filename.includes('\\');
}
