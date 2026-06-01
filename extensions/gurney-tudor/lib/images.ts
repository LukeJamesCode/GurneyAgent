// Lesson image support. Tudor only pulls images from the same web pages already
// approved/used for a course, then asks the local multimodal model whether a
// candidate actually fits the current segment before saving it.

import type { ChatMessage, LLM, ProfileName } from '../../../src/core/llm.js';
import type { Logger } from '../../../src/util/log.js';
import type { ImageCandidate, SegmentKind, Source } from './types.js';
import { chooseModel } from './generate.js';

interface WebsearchImageModule {
  imagesFromSources: (
    sources: Array<{ url: string }>,
    opts?: { maxImagesPerSource?: number; timeoutMs?: number },
  ) => Promise<ImageCandidate[]>;
}

export interface VerifiedSegmentImage {
  sourceUrl: string;
  imageUrl: string;
  altText: string;
  caption: string;
}

const IMAGE_UA =
  'Mozilla/5.0 (compatible; gurney-tudor/0.1; +https://github.com/LukeJamesCode/GurneyAgent)';
const MAX_IMAGE_BYTES = 2_000_000;
const MAX_CANDIDATES_PER_SEGMENT = 3;
const MAX_REDIRECTS = 4;

async function loadWebsearchImages(): Promise<WebsearchImageModule | null> {
  try {
    const spec = ['..', '..', 'gurney-websearch', 'lib', 'research.js'].join('/');
    const mod = (await import(spec)) as Partial<WebsearchImageModule>;
    if (typeof mod.imagesFromSources === 'function') return mod as WebsearchImageModule;
    return null;
  } catch {
    return null;
  }
}

export async function collectImageCandidates(
  sources: Source[],
  log: Logger,
): Promise<ImageCandidate[]> {
  if (sources.length === 0) return [];
  const ws = await loadWebsearchImages();
  if (!ws) return [];
  try {
    const images = await ws.imagesFromSources(sources, {
      maxImagesPerSource: 8,
      timeoutMs: 12_000,
    });
    const seen = new Set<string>();
    return images.filter((img) => {
      if (!img.imageUrl || seen.has(img.imageUrl)) return false;
      seen.add(img.imageUrl);
      return true;
    });
  } catch (e) {
    log.warn('tudor: collecting web images failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

function words(text: string): Set<string> {
  const ignore = new Set([
    'about',
    'after',
    'also',
    'and',
    'are',
    'because',
    'before',
    'course',
    'for',
    'from',
    'into',
    'lesson',
    'module',
    'that',
    'the',
    'this',
    'with',
    'you',
    'your',
  ]);
  return new Set(
    text
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !ignore.has(w)),
  );
}

function imageText(img: ImageCandidate): string {
  return [img.alt ?? '', img.imageUrl, img.pageUrl].join(' ');
}

function scoreCandidate(query: Set<string>, img: ImageCandidate): number {
  const hay = words(imageText(img));
  let score = 0;
  for (const w of query) if (hay.has(w)) score += 3;
  if (img.alt && img.alt.trim().length >= 8) score += 2;
  if (img.width !== undefined && img.height !== undefined) {
    if (img.width >= 500 && img.height >= 280) score += 2;
    if (img.width < 180 || img.height < 120) score -= 6;
  }
  if (/\b(diagram|chart|map|figure|photo|image|illustration|example)\b/i.test(imageText(img)))
    score += 1;
  return score;
}

function shortlist(
  candidates: ImageCandidate[],
  args: {
    courseTitle: string;
    moduleTitle: string;
    lessonTitle: string;
    kind: SegmentKind;
    body: string;
  },
): ImageCandidate[] {
  const q = words(
    [args.courseTitle, args.moduleTitle, args.lessonTitle, args.kind, args.body.slice(0, 500)].join(
      ' ',
    ),
  );
  return candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(q, candidate) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES_PER_SEGMENT)
    .map((r) => r.candidate);
}

function isSafeImageUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split('.').map((p) => Number.parseInt(p, 10));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
      return false;
    const [a, b] = parts as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a >= 224) return false;
  }
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return false;
    if (/^fe[89ab]/i.test(host)) return false;
    if (/^f[cd]/i.test(host)) return false;
    if (host.startsWith('::ffff:')) return false;
  }
  return true;
}

async function fetchImageBase64(url: string): Promise<string | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isSafeImageUrl(current) || /\.(svg|ico)(?:[?#]|$)/i.test(current)) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    try {
      const res = await fetch(current, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: { 'user-agent': IMAGE_UA, accept: 'image/*' },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return null;
        try {
          current = new URL(loc, current).toString();
        } catch {
          return null;
        }
        continue;
      }
      if (!res.ok) return null;
      const ct = res.headers.get('content-type') ?? '';
      if (!/^image\/(png|jpe?g|webp|gif)/i.test(ct)) return null;
      const len = Number.parseInt(res.headers.get('content-length') ?? '', 10);
      if (Number.isFinite(len) && len > MAX_IMAGE_BYTES) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
      return buf.toString('base64');
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function completeImageCheck(
  llm: LLM,
  ref: ProfileName | { model: string },
  messages: ChatMessage[],
): Promise<string> {
  let out = '';
  for await (const chunk of llm.chat({
    profile: ref,
    messages,
    maxTokens: 90,
    timeoutMs: 180_000,
  })) {
    if (chunk.delta) out += chunk.delta;
    if (out.length > 1200) break;
  }
  return out.trim();
}

function parseVerdict(text: string): { ok: boolean; caption: string } {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const yes = /^YES\b\s*:?\s*([\s\S]*)$/i.exec(cleaned);
  if (!yes) return { ok: false, caption: '' };
  const caption = (yes[1] ?? '').replace(/\s+/g, ' ').trim();
  return { ok: true, caption: caption.slice(0, 180) };
}

export async function verifyImageForSegment(
  llm: LLM,
  candidates: ImageCandidate[],
  args: {
    courseTitle: string;
    moduleTitle: string;
    lessonTitle: string;
    kind: SegmentKind;
    body: string;
  },
  log: Logger,
): Promise<VerifiedSegmentImage | null> {
  const ref = chooseModel(llm, 'local').ref;
  for (const candidate of shortlist(candidates, args)) {
    const image = await fetchImageBase64(candidate.imageUrl);
    if (!image) continue;
    try {
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            'You verify whether an image belongs in an educational slide. ' +
            'Reply only "YES: <short useful caption>" or "NO".',
        },
        {
          role: 'user',
          content: [
            `Course: ${args.courseTitle}`,
            `Module: ${args.moduleTitle}`,
            `Lesson: ${args.lessonTitle}`,
            `Slide kind: ${args.kind}`,
            `Slide text: ${args.body.slice(0, 900)}`,
            `Image alt text: ${candidate.alt ?? ''}`,
            `Image page: ${candidate.pageUrl}`,
            '',
            'Does this image directly help explain this exact slide? Be strict.',
          ].join('\n'),
          images: [image],
        },
      ];
      const verdict = parseVerdict(await completeImageCheck(llm, ref, messages));
      if (verdict.ok) {
        return {
          sourceUrl: candidate.pageUrl,
          imageUrl: candidate.imageUrl,
          altText: candidate.alt ?? '',
          caption: verdict.caption || candidate.alt || 'Relevant image from the source page.',
        };
      }
    } catch (e) {
      log.warn('tudor: image relevance check failed', {
        imageUrl: candidate.imageUrl,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return null;
}
