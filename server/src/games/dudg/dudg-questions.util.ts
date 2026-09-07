import fs from 'fs';
import path from 'path';

// Reads the same on-disk question folders the DUDG subprocess uses. Kept as a small,
// self-contained duplicate (not a cross-package import) so the main server's build
// doesn't depend on games/dudg/server's own TS project / build order.

const BASIC_DIR = path.resolve(__dirname, '../../../../games/dudg/server/questions');
const CUSTOM_DIR = path.resolve(__dirname, '../../../../games/dudg/server/customQuestions');

export interface DudgQuestionMeta {
  filename: string;
  title: string;
  labels: string[];
  source: 'basic' | 'custom';
}

function ensureDirs(): void {
  fs.mkdirSync(BASIC_DIR, { recursive: true });
  fs.mkdirSync(CUSTOM_DIR, { recursive: true });
}

function dirFor(source: 'basic' | 'custom'): string {
  return source === 'basic' ? BASIC_DIR : CUSTOM_DIR;
}

/** Extracts just the title (first "#" line) and "## Labels" section — no answer/hints/media parsing. */
function parseMeta(raw: string): { title: string; labels: string[] } {
  const titleMatch = raw.match(/^#(?!#)\s+(.*)/m);
  const title = titleMatch ? titleMatch[1].trim() : '(ohne Titel)';
  const labelsMatch = raw.match(/##\s+Labels\s*\n([\s\S]*?)(?:\n##\s|$)/i);
  const labels = labelsMatch
    ? labelsMatch[1]
        .split(/[,\n]/)
        .map((l) => l.trim())
        .filter(Boolean)
    : ['Basic'];
  return { title, labels: labels.length > 0 ? labels : ['Basic'] };
}

export function listQuestionMeta(): DudgQuestionMeta[] {
  ensureDirs();
  const out: DudgQuestionMeta[] = [];
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
        const { title, labels } = parseMeta(raw);
        out.push({ filename, title, labels, source });
      } catch {
        // skip unreadable/malformed files
      }
    }
  }
  return out.sort((a, b) => a.filename.localeCompare(b.filename));
}

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

export function isSafeFilename(filename: string): boolean {
  const name = filename.replace(/\.md$/, '');
  return FILENAME_SAFE.test(name) && !filename.includes('..') && !filename.includes('/') && !filename.includes('\\');
}

export function customQuestionsDir(): string {
  ensureDirs();
  return CUSTOM_DIR;
}
