import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import * as cheerio from 'cheerio';
import mammoth from 'mammoth';
import { getPath } from 'pdf-parse/worker';
import { PDFParse } from 'pdf-parse';
import ipaddr from 'ipaddr.js';
import dns from 'node:dns/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, fetch } from 'undici';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 10000);
const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
PDFParse.setWorker(getPath());

const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

function sameOrigin(req, origin) {
  try {
    const parsed = new URL(origin);
    const proto = (req.headers['x-forwarded-proto'] || req.protocol).split(',')[0].trim();
    return parsed.host === req.get('host') && parsed.protocol === `${proto}:`;
  } catch { return false; }
}

app.use((req, res, next) => {
  const origin = req.get('origin');
  if (!origin) return next();
  if (sameOrigin(req, origin) || FRONTEND_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  }
  if (req.method === 'OPTIONS') return res.sendStatus(403);
  // The request can still be handled server-side, but browsers cannot read the response.
  return next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '1h' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const name = (file.originalname || '').toLowerCase();
    const allowed = /\.(pdf|docx|txt|rtf)$/i.test(name) || [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain', 'application/rtf', 'text/rtf'
    ].includes(file.mimetype);
    cb(allowed ? null : new Error('Use a PDF, DOCX, TXT, or RTF file.'), allowed);
  }
});

function isPublicAddress(address) {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === 'unicast';
  } catch { return false; }
}

async function resolvePublicHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('That address is local or reserved and cannot be fetched.');
  }
  if (ipaddr.isValid(host)) {
    if (!isPublicAddress(host)) throw new Error('Private or reserved network addresses cannot be fetched.');
    return [{ address: host, family: ipaddr.process(host).kind() === 'ipv6' ? 6 : 4 }];
  }
  let records;
  try { records = await dns.lookup(hostname, { all: true, verbatim: true }); }
  catch { throw new Error('The website hostname could not be resolved. Check the URL and try again.'); }
  if (!records.length || records.some(record => !isPublicAddress(record.address))) {
    throw new Error('This hostname resolves to a private or reserved address and cannot be fetched.');
  }
  return records;
}

function makePinnedAgent(hostname, addresses) {
  const normalizedHost = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return new Agent({ connect: {
    lookup(requestedHost, options, callback) {
      if (requestedHost.toLowerCase().replace(/^\[|\]$/g, '') !== normalizedHost) {
        const error = new Error('Unexpected hostname during connection.');
        error.code = 'EHOSTUNREACH';
        return callback(error);
      }
      let candidates = addresses;
      if (options?.family) candidates = candidates.filter(a => a.family === options.family);
      if (!candidates.length) {
        const error = new Error('No approved address for this host.');
        error.code = 'EAI_ADDRFAMILY';
        return callback(error);
      }
      if (options?.all) return callback(null, candidates.map(a => ({ address: a.address, family: a.family })));
      return callback(null, candidates[0].address, candidates[0].family);
    }
  } });
}

function describeNetworkError(error) {
  const parts = [];
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && depth < 6; depth++, current = current.cause) {
    const code = typeof current.code === 'string' ? current.code : '';
    const message = typeof current.message === 'string' ? current.message.trim() : '';
    const part = [code, message].filter(Boolean).join(': ');
    if (part && !seen.has(part)) { seen.add(part); parts.push(part); }
    if (Array.isArray(current.errors)) {
      for (const nested of current.errors.slice(0, 3)) {
        const nestedCode = typeof nested?.code === 'string' ? nested.code : '';
        const nestedMessage = typeof nested?.message === 'string' ? nested.message.trim() : '';
        const nestedPart = [nestedCode, nestedMessage].filter(Boolean).join(': ');
        if (nestedPart && !seen.has(nestedPart)) { seen.add(nestedPart); parts.push(nestedPart); }
      }
    }
  }

  const codes = parts.join(' ');
  if (/ENOTFOUND|EAI_AGAIN|EAI_NONAME/.test(codes)) {
    return 'DNS lookup failed. Check the hostname or the server’s outbound DNS access.';
  }
  if (/CERT_|SELF_SIGNED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS/.test(codes)) {
    return 'The website’s TLS certificate could not be verified. Try the canonical HTTPS URL.';
  }
  if (/ECONNREFUSED/.test(codes)) {
    return 'The website refused the connection. It may block server-side requests.';
  }
  if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|ESOCKETTIMEDOUT/.test(codes)) {
    return 'The connection timed out before the website responded.';
  }
  if (/ECONNRESET|UND_ERR_SOCKET/.test(codes)) {
    return 'The website or network closed the connection before a response arrived.';
  }
  return parts.length ? parts.join(' → ') : 'No additional network error details were provided by the runtime.';
}

async function safeFetch(startUrl) {
  let current;
  try { current = new URL(startUrl); } catch { throw new Error('Enter a complete URL, such as https://example.com/article.'); }
  if (!['http:', 'https:'].includes(current.protocol)) throw new Error('Only HTTP and HTTPS links are supported.');
  if (current.username || current.password) throw new Error('URLs containing usernames or passwords are not supported.');

  for (let hop = 0; hop <= 4; hop++) {
    if (!['http:', 'https:'].includes(current.protocol)) throw new Error('The link redirected to an unsupported protocol.');
    if (current.port) throw new Error('Links on nonstandard ports are not supported. Use the normal website URL.');
    const addresses = await resolvePublicHost(current.hostname);
    const dispatcher = makePinnedAgent(current.hostname, addresses);
    let response;
    try {
      response = await fetch(current, {
        method: 'GET', redirect: 'manual', dispatcher,
        signal: AbortSignal.timeout(18000),
        headers: {
          'user-agent': 'CiteRightAPA7/1.0 (self-hosted metadata extraction)',
          'accept': 'text/html,application/xhtml+xml,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,*/*;q=0.7'
        }
      });
    } catch (error) {
      await dispatcher.close().catch(() => {});
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new Error('The website took too long to respond. Try another link or enter metadata manually.');
      }
      throw new Error(`Could not reach that website. ${describeNetworkError(error)}`);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      response.body?.cancel().catch(() => {});
      await dispatcher.close().catch(() => {});
      if (!location) throw new Error('The website sent an incomplete redirect.');
      if (hop === 4) throw new Error('The website redirected too many times.');
      current = new URL(location, current);
      if (current.username || current.password) throw new Error('Redirects to URLs containing credentials are blocked.');
      continue;
    }
    if (!response.ok) {
      response.body?.cancel().catch(() => {});
      await dispatcher.close().catch(() => {});
      throw new Error(`The website returned HTTP ${response.status}. It may block automated access.`);
    }
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_DOWNLOAD_BYTES) {
      response.body?.cancel().catch(() => {});
      await dispatcher.close().catch(() => {});
      throw new Error('That document is larger than the 15 MB limit. Upload a smaller copy instead.');
    }
    try {
      const chunks = [];
      let total = 0;
      const reader = response.body?.getReader();
      if (!reader) return { url: current.href, contentType: response.headers.get('content-type') || '', buffer: Buffer.alloc(0), headers: response.headers };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_DOWNLOAD_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error('That document is larger than the 15 MB limit.');
        }
        chunks.push(Buffer.from(value));
      }
      return {
        url: current.href,
        contentType: response.headers.get('content-type') || '',
        buffer: Buffer.concat(chunks),
        headers: response.headers
      };
    } finally {
      await dispatcher.close().catch(() => {});
    }
  }
  throw new Error('Could not follow the website redirect.');
}

function firstNonEmpty(...values) {
  return values.flat().find(value => typeof value === 'string' && value.trim())?.trim() || '';
}
function cleanText(value, max = 12000) {
  return String(value || '').replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, max);
}
function normalizeDate(value) {
  const raw = cleanText(value, 80);
  if (!raw) return '';
  const partial = raw.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/);
  if (partial) return `${partial[1]}${partial[2] ? `-${String(partial[2]).padStart(2, '0')}` : ''}${partial[3] ? `-${String(partial[3]).padStart(2, '0')}` : ''}`;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}-${String(parsed.getUTCDate()).padStart(2, '0')}`;
}
function extractDOI(value = '') {
  const match = String(value).match(/\b10\.\d{4,9}\/[^\s"<>]+/i);
  return match ? match[0].replace(/[.,;]+$/, '').replace(/[)\]]+$/, '') : '';
}
function metaContent($, selectors) {
  for (const selector of selectors) {
    const value = $(selector).first().attr('content') || $(selector).first().attr('href');
    if (value?.trim()) return value.trim();
  }
  return '';
}
function parseJsonLd($) {
  const values = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    try {
      const parsed = JSON.parse($(el).contents().text());
      const add = item => {
        if (!item || typeof item !== 'object') return;
        if (Array.isArray(item)) return item.forEach(add);
        if (item['@graph']) add(item['@graph']);
        values.push(item);
      };
      add(parsed);
    } catch { /* Ignore malformed JSON-LD. */ }
  });
  return values;
}
function jsonAuthorList(author) {
  if (!author) return [];
  const list = Array.isArray(author) ? author : [author];
  return list.map(item => {
    if (typeof item === 'string') return item.trim();
    if (!item || typeof item !== 'object') return '';
    if (item.name) return String(item.name).trim();
    const family = item.family || '';
    const given = item.given || '';
    return [family, given].filter(Boolean).join(', ');
  }).filter(Boolean).slice(0, 50);
}
function looksLikeGroupAuthor(author) {
  const list = Array.isArray(author) ? author : [author];
  return list.some(item => {
    if (item && typeof item === 'object') {
      const type = String(item['@type'] || item.type || '').toLowerCase();
      if (type.includes('organization') || type.includes('corporation') || type.includes('governmentorganization')) return true;
    }
    const name = typeof item === 'string' ? item : item?.name || '';
    return /\b(association|organizations?|organisations?|department|ministry|agency|bureau|office|cent(er|re)|foundation|corporation|company|university|college|school district|city of|county of|committee|institutes?|council|society|hospital|clinic|police department|clubs?|publisher|network|coalition|government|administration|times|tribune|chronicle|herald|gazette|reporter|press|journal|magazine)\b/i.test(name);
  });
}

function parseHtml(buffer, url) {
  const html = buffer.toString('utf8');
  const $ = cheerio.load(html);
  const ld = parseJsonLd($);
  const articleLd = ld.find(item => /Article|Report|ScholarlyArticle|WebPage|NewsArticle|BlogPosting/i.test(String(item['@type'] || '')) && (item.headline || item.name || item.author)) || ld[0] || {};
  const citationAuthors = [];
  $('meta[name="citation_author"], meta[name="DC.Creator"], meta[name="dc.creator"], meta[name="author"]')
    .each((_i, el) => { const v = $(el).attr('content'); if (v?.trim()) citationAuthors.push(v.trim()); });
  const authors = citationAuthors.length ? citationAuthors : jsonAuthorList(articleLd.author);
  const title = firstNonEmpty(
    metaContent($, ['meta[name="citation_title"]','meta[name="DC.title"]','meta[name="dc.title"]','meta[property="og:title"]','meta[name="twitter:title"]']),
    articleLd.headline, articleLd.name, $('h1').first().text(), $('title').first().text()
  );
  const date = firstNonEmpty(
    metaContent($, ['meta[name="citation_publication_date"]','meta[name="citation_date"]','meta[property="article:published_time"]','meta[name="date"]','meta[name="DC.date"]','meta[name="dc.date"]','meta[name="pubdate"]','meta[name="publish_date"]']),
    articleLd.datePublished
  );
  const modified = firstNonEmpty(metaContent($, ['meta[property="article:modified_time"]','meta[name="last-modified"]']), articleLd.dateModified);
  const canonical = $('link[rel="canonical"]').attr('href');
  let finalUrl = url;
  if (canonical) {
    try {
      const candidate = new URL(canonical, url);
      if (['http:', 'https:'].includes(candidate.protocol)) finalUrl = candidate.href;
    } catch { /* Ignore malformed canonical links and retain the fetched URL. */ }
  }
  const siteName = firstNonEmpty(metaContent($, ['meta[property="og:site_name"]']), articleLd.publisher?.name, new URL(url).hostname.replace(/^www\./, ''));
  const doi = extractDOI(firstNonEmpty(metaContent($, ['meta[name="citation_doi"]','meta[name="dc.identifier"]','meta[name="DC.Identifier"]']), $('a[href*="doi.org/"]').first().attr('href'), url));
  const publicationTitle = firstNonEmpty(metaContent($, ['meta[name="citation_journal_title"]','meta[name="citation_conference_title"]']), articleLd.isPartOf?.name);
  const volume = metaContent($, ['meta[name="citation_volume"]']);
  const issue = metaContent($, ['meta[name="citation_issue"]']);
  const pages = metaContent($, ['meta[name="citation_firstpage"]']);
  const lastPage = metaContent($, ['meta[name="citation_lastpage"]']);
  const publisher = firstNonEmpty(metaContent($, ['meta[name="citation_publisher"]','meta[name="publisher"]','meta[name="DC.publisher"]','meta[name="dc.publisher"]']), articleLd.publisher?.name);
  const description = firstNonEmpty(metaContent($, ['meta[name="description"]','meta[property="og:description"]']), articleLd.description);
  const isJournal = Boolean(publicationTitle || $('meta[name="citation_journal_title"]').length);
  const sourceType = isJournal ? 'journal' : (articleLd['@type'] === 'Report' ? 'report' : 'website');
  return {
    sourceType, title: cleanText(title), authors: authors.map(value => cleanText(value)).filter(Boolean),
    groupAuthor: citationAuthors.length ? looksLikeGroupAuthor(citationAuthors) : looksLikeGroupAuthor(articleLd.author),
    yearDate: normalizeDate(date), modifiedDate: normalizeDate(modified), siteName: cleanText(siteName), publisher: cleanText(publisher),
    url: finalUrl, doi, journal: cleanText(publicationTitle), volume: cleanText(volume), issue: cleanText(issue),
    pages: cleanText(pages && lastPage ? `${pages}-${lastPage}` : pages), description: cleanText(description, 1200),
    accessedAs: 'webpage', warnings: []
  };
}

function guessTitleFromText(text, fallback) {
  const lines = String(text || '').split(/\r?\n/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const candidate = lines.find(line => line.length >= 4 && line.length <= 180 && !/^(page\s+\d+|https?:\/\/|doi\s*:)/i.test(line));
  return cleanText(candidate || fallback || '', 240);
}
function authorFromPdfInfo(value) {
  const author = cleanText(value, 500);
  if (!author) return [];
  return author.split(/\s*;\s*|\s+&\s+/).filter(Boolean).slice(0, 20);
}

async function extractPdf(buffer, filename = 'document.pdf', url = '') {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  let text = '';
  let info = {};
  let infoError = null;
  try {
    const textResult = await parser.getText();
    text = textResult?.text || '';
    try { info = await parser.getInfo({ parsePageInfo: false }); } catch (error) { infoError = error; }
  } finally {
    try { await parser.destroy(); } catch { /* Cleanup errors should not discard extracted metadata. */ }
  }
  const meta = info?.infoData || info?.info || info?.metadata || info || {};
  const title = cleanText(meta.Title || meta.title || guessTitleFromText(text, path.basename(filename, path.extname(filename))), 240);
  const authors = authorFromPdfInfo(meta.Author || meta.author || '');
  const creationDate = meta.CreationDate || meta.CreationDateString || meta.creationDate || '';
  const dateMatch = String(creationDate).match(/D:(\d{4})(\d{2})?(\d{2})?/);
  const date = dateMatch ? `${dateMatch[1]}-${dateMatch[2] || '01'}-${dateMatch[3] || '01'}` : '';
  const warnings = [];
  if (!text.trim()) warnings.push('No selectable text was found. This may be a scanned PDF; its metadata may need to be entered manually.');
  if (infoError) warnings.push('Some embedded PDF metadata could not be read.');
  if (!authors.length) warnings.push('No author was detected in the PDF metadata. Check the first page and enter the author if available.');
  if (date) warnings.push('The suggested date comes from the PDF file creation metadata, which may not be its publication date. Confirm it from the document itself.');
  else warnings.push('No publication date was detected. Check the document itself before using (n.d.).');
  return {
    sourceType: 'report', title, authors, yearDate: normalizeDate(date), publisher: '', siteName: '', url,
    doi: extractDOI(text.slice(0, 5000)) || extractDOI(url), description: '', documentTextPreview: cleanText(text, 1200),
    accessedAs: 'pdf', warnings
  };
}
async function extractDocx(buffer, filename = 'document.docx', url = '') {
  const result = await mammoth.extractRawText({ buffer });
  const text = result.value || '';
  const warnings = [];
  if (!text.trim()) warnings.push('No readable text was extracted from this DOCX. Please enter the citation details manually.');
  return {
    sourceType: 'report', title: guessTitleFromText(text, path.basename(filename, path.extname(filename))),
    authors: [], yearDate: '', publisher: '', siteName: '', url, doi: extractDOI(text.slice(0, 5000)) || extractDOI(url),
    description: '', documentTextPreview: cleanText(text, 1200), accessedAs: 'docx',
    warnings: [...warnings, 'The document text was read, but author and publication details may need manual review.']
  };
}
function extractRtfText(value) {
  return value.replace(/\\par[d]?\b/g, '\n').replace(/\\'[0-9a-f]{2}/gi, ' ').replace(/\\[a-z]+-?\d* ?/gi, ' ').replace(/[{}]/g, ' ').replace(/\s+/g, ' ').trim();
}
async function extractDocument(buffer, filename, contentType, url = '') {
  const lower = `${filename} ${contentType}`.toLowerCase();
  if (lower.includes('application/pdf') || /\.pdf(?:\?|$)/i.test(filename) || buffer.subarray(0, 5).toString() === '%PDF-') {
    return extractPdf(buffer, filename || 'document.pdf', url);
  }
  if (lower.includes('wordprocessingml') || /\.docx(?:\?|$)/i.test(filename)) return extractDocx(buffer, filename || 'document.docx', url);
  if (lower.includes('application/rtf') || lower.includes('text/rtf') || /\.rtf(?:\?|$)/i.test(filename)) {
    const text = extractRtfText(buffer.toString('utf8'));
    return { sourceType: 'report', title: guessTitleFromText(text, path.basename(filename, path.extname(filename))), authors: [], yearDate: '', publisher: '', siteName: '', url, doi: extractDOI(text.slice(0, 5000)) || extractDOI(url), description: '', documentTextPreview: cleanText(text, 1200), accessedAs: 'rtf', warnings: ['RTF text was extracted; author and publication details may need manual review.'] };
  }
  if (lower.includes('text/plain') || /\.txt(?:\?|$)/i.test(filename)) {
    const text = buffer.toString('utf8');
    return { sourceType: 'report', title: guessTitleFromText(text, path.basename(filename, path.extname(filename))), authors: [], yearDate: '', publisher: '', siteName: '', url, doi: extractDOI(text.slice(0, 5000)) || extractDOI(url), description: '', documentTextPreview: cleanText(text, 1200), accessedAs: 'text', warnings: ['Text was extracted; verify title, author, and date against the original document.'] };
  }
  return null;
}

function crossrefAuthorList(list = []) {
  return list.map(a => [a.family || a.name || '', a.given || ''].filter(Boolean).join(', ')).filter(Boolean).slice(0, 50);
}
function crossrefDate(item) {
  const parts = item?.['published-print']?.['date-parts']?.[0] || item?.['published-online']?.['date-parts']?.[0] || item?.published?.['date-parts']?.[0] || item?.issued?.['date-parts']?.[0] || [];
  if (!parts.length) return '';
  return `${parts[0]}-${String(parts[1] || 1).padStart(2, '0')}-${String(parts[2] || 1).padStart(2, '0')}`;
}
function normalizeCrossrefItem(item, fallbackDoi = '') {
  const type = String(item.type || '').toLowerCase();
  const journal = item['container-title']?.[0] || '';
  return {
    sourceType: /journal|proceedings-article/.test(type) ? 'journal' : (/book|monograph|edited-book/.test(type) ? 'book' : 'report'),
    title: cleanText(item.title?.[0] || '', 500), authors: crossrefAuthorList(item.author || item.editor || []), groupAuthor: false,
    yearDate: crossrefDate(item), journal: cleanText(journal), volume: cleanText(item.volume), issue: cleanText(item.issue),
    pages: cleanText(item.page || item['article-number']), publisher: cleanText(item.publisher), siteName: '',
    url: firstNonEmpty(item.URL, item.link?.[0]?.URL), doi: cleanText(item.DOI || fallbackDoi), abstract: cleanText(item.abstract || '', 1800),
    accessedAs: 'crossref', warnings: []
  };
}
async function getCrossrefByDoi(doi) {
  const cleanDoi = decodeURIComponent(doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
  if (!/^10\.\d{4,9}\//i.test(cleanDoi) || /[\r\n]/.test(cleanDoi)) throw new Error('Enter a valid DOI, such as 10.1038/s41586-020-2649-2.');
  const encodedDoi = cleanDoi.split('/').map(part => encodeURIComponent(part)).join('/');
  const { buffer } = await safeFetch(`https://api.crossref.org/works/${encodedDoi}`);
  const json = JSON.parse(buffer.toString('utf8'));
  if (!json?.message) throw new Error('Crossref did not return metadata for that DOI.');
  return normalizeCrossrefItem(json.message, cleanDoi);
}

async function enrichDocumentWithDoi(metadata, documentUrl = '') {
  if (!metadata?.doi) return metadata;
  try {
    const crossref = await getCrossrefByDoi(metadata.doi);
    if (!crossref.title) return metadata;
    const warnings = (metadata.warnings || []).filter(warning =>
      !(crossref.authors?.length && /No author was detected/i.test(warning)) &&
      !(crossref.yearDate && /PDF file creation metadata/i.test(warning))
    );
    return {
      ...metadata,
      ...crossref,
      authors: crossref.authors?.length ? crossref.authors : metadata.authors,
      yearDate: crossref.yearDate || metadata.yearDate,
      groupAuthor: crossref.authors?.length ? false : Boolean(metadata.groupAuthor),
      url: documentUrl || metadata.url || crossref.url,
      documentTextPreview: metadata.documentTextPreview || '',
      accessedAs: metadata.accessedAs,
      warnings: [...warnings, 'Publication metadata was matched by DOI through Crossref. Verify it against the document.']
    };
  } catch { return metadata; }
}

app.get('/health', (_req, res) => res.json({ ok: true, app: 'CiteRight APA 7', version: '1.0.0' }));
app.get('/api/doi', async (req, res) => {
  try {
    const doi = String(req.query.doi || '').trim();
    const metadata = await getCrossrefByDoi(doi);
    res.json({ ok: true, metadata });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || 'DOI lookup failed.' });
  }
});
app.get('/api/search', async (req, res) => {
  try {
    const query = cleanText(req.query.q, 300);
    if (query.length < 3) return res.status(400).json({ ok: false, error: 'Enter at least 3 characters to search Crossref.' });
    const url = new URL('https://api.crossref.org/works');
    url.searchParams.set('query.bibliographic', query);
    url.searchParams.set('rows', '8');
    const { buffer } = await safeFetch(url.href);
    const json = JSON.parse(buffer.toString('utf8'));
    const results = (json?.message?.items || []).map(item => normalizeCrossrefItem(item)).filter(item => item.title);
    res.json({ ok: true, results });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message || 'Crossref search failed.' });
  }
});
app.post('/api/inspect', async (req, res) => {
  try {
    const url = cleanText(req.body?.url, 2000);
    if (!url) return res.status(400).json({ ok: false, error: 'Paste a webpage or document URL first.' });
    const doi = extractDOI(url);
    if (doi && /(^|\/)doi\.org\//i.test(url)) {
      try {
        const metadata = await getCrossrefByDoi(doi);
        metadata.url = `https://doi.org/${doi}`;
        return res.json({ ok: true, metadata, note: 'Metadata retrieved from Crossref using the DOI.' });
      } catch { /* Fall back to the URL itself. */ }
    }
    const fetched = await safeFetch(url);
    const finalUrl = fetched.url;
    const contentType = fetched.contentType.toLowerCase();
    const urlPath = new URL(finalUrl).pathname.toLowerCase();
    if (contentType.includes('application/pdf') || urlPath.endsWith('.pdf') || fetched.buffer.subarray(0, 5).toString() === '%PDF-') {
      let metadata = await extractPdf(fetched.buffer, path.basename(urlPath) || 'document.pdf', finalUrl);
      metadata = await enrichDocumentWithDoi(metadata, finalUrl);
      return res.json({ ok: true, metadata, note: 'PDF text and embedded metadata were examined. Review the author, title, and date.' });
    }
    if (contentType.includes('wordprocessingml') || urlPath.endsWith('.docx')) {
      let metadata = await extractDocx(fetched.buffer, path.basename(urlPath) || 'document.docx', finalUrl);
      metadata = await enrichDocumentWithDoi(metadata, finalUrl);
      return res.json({ ok: true, metadata, note: 'DOCX text was extracted. Review the citation details before using the reference.' });
    }
    if (contentType.startsWith('text/plain') || urlPath.endsWith('.txt') || urlPath.endsWith('.rtf')) {
      let metadata = await extractDocument(fetched.buffer, path.basename(urlPath), contentType, finalUrl);
      if (metadata) {
        metadata = await enrichDocumentWithDoi(metadata, finalUrl);
        return res.json({ ok: true, metadata, note: 'Document text was extracted. Verify missing citation details manually.' });
      }
    }
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml') && !contentType.includes('application/octet-stream')) {
      throw new Error(`That link returned an unsupported file type (${contentType || 'unknown'}). Use a webpage, PDF, DOCX, TXT, or RTF link.`);
    }
    const metadata = parseHtml(fetched.buffer, finalUrl);
    if (!metadata.title) metadata.warnings.push('A page title could not be detected. Enter the exact title from the source.');
    if (!metadata.authors.length) metadata.warnings.push('No author was detected. Check whether an organization should be listed as the author.');
    if (!metadata.yearDate) metadata.warnings.push('No publication date was detected. Use (n.d.) only if the source truly has no date.');
    if (metadata.doi) {
      try {
        const crossref = await getCrossrefByDoi(metadata.doi);
        if (crossref.title && (!metadata.title || crossref.title.length > metadata.title.length)) {
          const merged = { ...metadata, ...crossref, url: metadata.url, siteName: metadata.siteName || crossref.siteName };
          return res.json({ ok: true, metadata: merged, note: 'Page metadata was supplemented with Crossref DOI metadata.' });
        }
      } catch { /* Page metadata remains usable. */ }
    }
    res.json({ ok: true, metadata, note: 'Page metadata was extracted. Check it against the original source; some sites hide author/date details or block automated access.' });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || 'Could not inspect that source.' });
  }
});
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Choose a PDF, DOCX, TXT, or RTF file first.' });
    let metadata = await extractDocument(req.file.buffer, req.file.originalname, req.file.mimetype, '');
    if (!metadata) return res.status(415).json({ ok: false, error: 'That file type is not supported.' });
    metadata = await enrichDocumentWithDoi(metadata, '');
    res.json({ ok: true, metadata, note: 'The file was processed in memory and was not saved to disk. Verify extracted information before citing.' });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || 'Could not read that document.' });
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ ok: false, error: 'Files must be 15 MB or smaller.' });
  }
  res.status(400).json({ ok: false, error: error.message || 'The request could not be processed.' });
});

app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/health') return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CiteRight APA 7 listening on port ${PORT}`);
});
