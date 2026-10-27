const STORAGE_KEY = 'citeright.apa7.bibliography.v1';
const API_KEY = 'citeright.apa7.apiBase.v1';
const byId = id => document.getElementById(id);
const fields = ['title','authors','sourceType','yearDate','siteName','publisher','url','doi','journal','volume','issue','pages','edition'];
const form = byId('metadataForm');
let bibliography = loadBibliography();
let editingId = null;
let selectedFile = null;
let toastTimer = null;

function trimSlash(value) { return String(value || '').trim().replace(/\/+$/, ''); }
function currentOrigin() {
  return ['http:', 'https:'].includes(location.protocol) ? location.origin : 'http://localhost:10000';
}
let apiBase = trimSlash(readStorage(API_KEY) || currentOrigin());
function readStorage(key) { try { return localStorage.getItem(key); } catch { return null; } }
function writeStorage(key, value) { try { localStorage.setItem(key, value); } catch { /* Storage can be disabled in private browsing. */ } }
function loadBibliography() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(data) ? data.filter(item => item && item.id && item.title) : [];
  } catch { return []; }
}
function saveBibliography() { writeStorage(STORAGE_KEY, JSON.stringify(bibliography)); }
function apiUrl(path) { return `${trimSlash(apiBase)}${path.startsWith('/') ? path : `/${path}`}`; }
function escapeHtml(value) {
  return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function showToast(message) {
  const toast = byId('toast'); toast.textContent = message; toast.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2400);
}
function setStatus(message, kind = 'info', target = 'statusMessage') {
  const el = byId(target); if (!el) return;
  el.textContent = message; el.className = `status-message ${kind}`; el.hidden = !message;
}
function setBusy(button, busy, text) {
  if (!button) return;
  if (busy) { button.dataset.originalText = button.innerHTML; button.disabled = true; button.textContent = text || 'Working…'; }
  else { button.disabled = false; if (button.dataset.originalText) button.innerHTML = button.dataset.originalText; }
}
async function requestJson(path, options = {}) {
  const response = await fetch(apiUrl(path), options);
  let data;
  try { data = await response.json(); } catch { throw new Error(`The backend returned an unreadable response (HTTP ${response.status}).`); }
  if (!response.ok || data?.ok === false) throw new Error(data?.error || `Request failed (HTTP ${response.status}).`);
  return data;
}

function fieldValue(name) { return form.elements.namedItem(name)?.value?.trim() || ''; }
function collectSource() {
  return {
    id: editingId || `cr-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
    title: fieldValue('title'), authors: fieldValue('authors').split(/\n+/).map(s => s.trim()).filter(Boolean),
    groupAuthor: byId('groupAuthor').checked, sourceType: fieldValue('sourceType') || 'website',
    yearDate: fieldValue('yearDate'), siteName: fieldValue('siteName'), publisher: fieldValue('publisher'),
    url: fieldValue('url'), doi: fieldValue('doi'), journal: fieldValue('journal'), volume: fieldValue('volume'),
    issue: fieldValue('issue'), pages: fieldValue('pages'), edition: fieldValue('edition'),
    sentenceCase: byId('sentenceCase').checked
  };
}
function normalizeDateInput(value) {
  const date = String(value || '').trim();
  if (!date) return '';
  const iso = date.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?/);
  if (iso) return `${iso[1]}${iso[2] ? `-${String(iso[2]).padStart(2,'0')}` : ''}${iso[3] ? `-${String(iso[3]).padStart(2,'0')}` : ''}`;
  const parsed = new Date(date);
  if (!Number.isNaN(parsed.getTime())) return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth()+1).padStart(2,'0')}-${String(parsed.getUTCDate()).padStart(2,'0')}`;
  return date;
}
function likelyGroupAuthor(authors) {
  if (!authors || authors.length !== 1) return false;
  const name = authors[0];
  return !name.includes(',') && /\b(association|organization|organisation|department|ministry|agency|bureau|office|center|centre|foundation|corporation|company|university|college|school district|city of|county of|committee|institutes?|council|society|hospital|clinic|police department|club|publisher|network|coalition|government|administration|editorial board|times|tribune|chronicle|herald|gazette|reporter|press|journal|magazine)\b/i.test(name);
}
function populateForm(metadata = {}) {
  for (const name of fields) {
    if (!form.elements.namedItem(name)) continue;
    const value = name === 'authors'
      ? (Array.isArray(metadata.authors) ? metadata.authors.join('\n') : String(metadata.authors || ''))
      : (metadata[name] ?? '');
    form.elements.namedItem(name).value = value;
  }
  byId('groupAuthor').checked = metadata.groupAuthor ?? likelyGroupAuthor(Array.isArray(metadata.authors) ? metadata.authors : String(metadata.authors || '').split(/\n+/).filter(Boolean));
  byId('sentenceCase').checked = metadata.sentenceCase !== false;
  const documentPreview = byId('documentPreview');
  if (metadata.documentTextPreview) {
    byId('documentTextPreview').textContent = metadata.documentTextPreview;
    documentPreview.hidden = false;
    documentPreview.open = false;
  } else {
    byId('documentTextPreview').textContent = '';
    documentPreview.hidden = true;
    documentPreview.open = false;
  }
  editingId = metadata.id || null;
  byId('draftPill').textContent = editingId ? 'Editing saved source' : 'New citation';
  byId('saveButton').innerHTML = editingId ? 'Save changes <span aria-hidden="true">✓</span>' : 'Add to bibliography <span aria-hidden="true">＋</span>';
  updateTypeFields(); updatePreview();
}
function clearForm() {
  editingId = null;
  form.reset();
  byId('groupAuthor').checked = false;
  byId('sentenceCase').checked = true;
  byId('draftPill').textContent = 'New citation';
  byId('saveButton').innerHTML = 'Add to bibliography <span aria-hidden="true">＋</span>';
  updateTypeFields(); updatePreview();
}
function updateTypeFields() {
  const type = fieldValue('sourceType') || 'website';
  document.querySelectorAll('[data-type-fields]').forEach(el => { el.hidden = !el.dataset.typeFields.split(/\s+/).includes(type); });
}
function sentenceCaseTitle(input) {
  const text = String(input || '').trim().replace(/\s+/g,' ');
  if (!text) return '';
  const lower = text.toLocaleLowerCase();
  const cased = lower.replace(/(^|[.!?]\s+|:\s+)([a-z])/g, (_all, prefix, char) => prefix + char.toLocaleUpperCase());
  return cased.replace(/\b([a-z0-9]{2,6})\b/gi, (word, _capture, offset) => {
    const original = text.slice(offset, offset + word.length);
    return /^[A-Z0-9]{2,6}$/.test(original) ? original : word;
  });
}
function displayTitle(source) { return source.sentenceCase === false ? source.title.trim() : sentenceCaseTitle(source.title); }
function nameParts(raw) {
  const cleaned = String(raw || '').trim().replace(/\s+/g,' ');
  if (!cleaned) return { family: '', initials: '' };
  if (cleaned.includes(',')) {
    const [familyPart, ...givenParts] = cleaned.split(',');
    const family = familyPart.trim();
    const given = givenParts.join(' ').trim().replace(/\b(Jr\.?|Sr\.?|II|III|IV)\b/i, '');
    const initials = given.split(/[\s-]+/).filter(Boolean).map(name => `${name[0].toLocaleUpperCase()}.`).join(' ');
    const suffix = /\b(Jr\.?|Sr\.?|II|III|IV)\b/i.exec(cleaned)?.[0];
    return { family: family + (suffix ? `, ${suffix.replace(/\.$/,'')}` : ''), initials };
  }
  const parts = cleaned.split(' ');
  if (parts.length === 1) return { family: cleaned, initials: '' };
  const suffixes = ['Jr.','Sr.','II','III','IV'];
  let suffix = '';
  if (suffixes.includes(parts.at(-1))) suffix = parts.pop();
  const family = parts.pop();
  const initials = parts.join(' ').split(/[-\s]+/).filter(Boolean).map(name => `${name[0].toLocaleUpperCase()}.`).join(' ');
  return { family: `${family}${suffix ? `, ${suffix.replace(/\.$/,'')}` : ''}`, initials };
}
function formattedAuthors(source) {
  const authors = (source.authors || []).map(s => String(s).trim()).filter(Boolean);
  if (!authors.length) return '';
  if (source.groupAuthor) return authors.length > 20 ? `${authors.slice(0,19).join(', ')}, … ${authors.at(-1)}` : authors.join(', ');
  const formatted = authors.map(raw => {
    const {family, initials} = nameParts(raw);
    return initials ? `${family}, ${initials}` : family;
  });
  if (formatted.length <= 20) {
    if (formatted.length === 1) return formatted[0];
    return `${formatted.slice(0,-1).join(', ')}, & ${formatted.at(-1)}`;
  }
  return `${formatted.slice(0,19).join(', ')}, … ${formatted.at(-1)}`;
}
function individualCitationName(raw, isGroup) {
  if (isGroup) return raw;
  return nameParts(raw).family.split(',')[0].trim();
}
function formattedDate(source) {
  const raw = normalizeDateInput(source.yearDate);
  if (!raw) return 'n.d.';
  const match = raw.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/);
  if (!match) return raw;
  const year = match[1];
  if (source.sourceType !== 'website' && source.sourceType !== 'video') return year;
  if (!match[2]) return year;
  const month = Number(match[2]);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return match[3] ? `${year}, ${months[month-1] || match[2]} ${Number(match[3])}` : `${year}, ${months[month-1] || match[2]}`;
}
function doiUrl(doi) {
  let raw = String(doi || '').trim();
  raw = raw.replace(/^https?:\/\/(dx\.)?doi\.org\//i,'').replace(/^doi\s*:\s*/i,'');
  return raw ? `https://doi.org/${raw}` : '';
}
function safeUrl(source) { return doiUrl(source.doi) || String(source.url || '').trim(); }
function authorShortTitle(source) {
  const clean = displayTitle(source).replace(/["“”]/g,'').trim();
  const words = clean.split(/\s+/).slice(0, 5).join(' ');
  return source.sourceType === 'website' || source.sourceType === 'journal' ? `“${words}${clean.split(/\s+/).length > 5 ? '…' : ''}”` : `*${words}${clean.split(/\s+/).length > 5 ? '…' : ''}*`;
}
function inTextCitation(source) {
  const authors = (source.authors || []).map(s => String(s).trim()).filter(Boolean);
  let who = '';
  if (authors.length === 0) who = authorShortTitle(source);
  else if (source.groupAuthor) who = authors[0];
  else if (authors.length === 1) who = individualCitationName(authors[0], false);
  else if (authors.length === 2) who = `${individualCitationName(authors[0], false)} & ${individualCitationName(authors[1], false)}`;
  else who = `${individualCitationName(authors[0], false)} et al.`;
  const year = /^\d{4}/.exec(normalizeDateInput(source.yearDate))?.[0] || 'n.d.';
  return `(${who}, ${year})`;
}
function makeReference(source) {
  const author = formattedAuthors(source);
  const title = displayTitle(source);
  const date = formattedDate(source);
  const url = safeUrl(source);
  const site = String(source.siteName || '').trim();
  const publisher = String(source.publisher || '').trim();
  const isGroupSameAsSite = source.groupAuthor && source.authors?.[0] && site.toLowerCase() === source.authors[0].toLowerCase();
  const siteSuffix = site && !isGroupSameAsSite && site.toLowerCase() !== author.toLowerCase() ? `${site}. ` : '';
  const urlSuffix = url ? url : '';
  if (source.sourceType === 'journal') {
    const lead = author ? `${author}. ` : `${title}. `;
    const dateBit = author ? `(${date}). ` : `(${date}). `;
    const articleTitle = author ? `${title}. ` : '';
    const journal = String(source.journal || site || '').trim();
    const volumeIssue = source.volume ? `*${journal}${journal ? ', ' : ''}${source.volume}*${source.issue ? `(${source.issue})` : ''}` : (journal ? `*${journal}*` : '');
    const pages = source.pages ? `, ${source.pages}` : '';
    const tail = urlSuffix ? `${urlSuffix}` : '';
    return `${lead}${dateBit}${articleTitle}${volumeIssue}${pages}${volumeIssue ? '. ' : ''}${tail}`.trim();
  }
  if (source.sourceType === 'book') {
    const titleBit = `*${title}*${source.edition ? ` (${source.edition})` : ''}`;
    const publisherBit = publisher && publisher.toLowerCase() !== author.toLowerCase() ? `${publisher}. ` : '';
    if (author) return `${author}. (${date}). ${titleBit}. ${publisherBit}${urlSuffix}`.replace(/\s+/g,' ').trim();
    return `${titleBit}. (${date}). ${publisherBit}${urlSuffix}`.replace(/\s+/g,' ').trim();
  }
  if (source.sourceType === 'report') {
    if (!author) {
      const publicationName = publisher || site;
      return `*${title}*. (${date}). ${publicationName ? `${publicationName}. ` : ''}${urlSuffix || ''}`.replace(/\s+/g,' ').trim();
    }
    const publisherBit = publisher && publisher.toLowerCase() !== author.toLowerCase() ? `${publisher}. ` : '';
    return `${author}. (${date}). *${title}*. ${publisherBit}${urlSuffix || ''}`.replace(/\s+/g,' ').trim();
  }
  if (source.sourceType === 'video') {
    const lead = author || site;
    const base = lead ? `${lead}. (${date}). *${title}* [Video]. ` : `*${title}*. (${date}). [Video]. `;
    return `${base}${site && lead.toLowerCase() !== site.toLowerCase() ? `${site}. ` : ''}${urlSuffix || ''}`.replace(/\s+/g,' ').trim();
  }
  // Web page: omit the website name when it duplicates the author.
  const lead = author ? `${author}. (${date}). ` : '';
  const titlePart = `*${title}*`;
  const body = author ? `${lead}${titlePart}. ` : `${titlePart}. (${date}). `;
  const omitSite = site && (site.toLowerCase() === author.toLowerCase() || (source.groupAuthor && source.authors?.[0]?.toLowerCase() === site.toLowerCase()));
  return `${body}${site && !omitSite ? `${site}. ` : ''}${urlSuffix}`.replace(/\s+/g,' ').trim();
}
function markupToHtml(markup) {
  const pieces = String(markup || '').split('*');
  return pieces.map((part, index) => index % 2 ? `<em>${escapeHtml(part)}</em>` : escapeHtml(part)).join('');
}
function markupToPlain(markup) { return String(markup || '').replace(/\*/g,''); }
function updatePreview() {
  const source = collectSource();
  const reference = source.title ? makeReference(source) : '';
  const preview = byId('referencePreview');
  if (reference) { preview.innerHTML = markupToHtml(reference); preview.classList.remove('empty'); }
  else { preview.textContent = 'Your formatted reference will appear here as you fill in the source details.'; preview.classList.add('empty'); }
  byId('inTextPreview').innerHTML = source.title ? markupToHtml(inTextCitation(source)) : '(Author, Year)';
}
function typeLabel(type) { return ({website:'Web page',journal:'Journal article',book:'Book',report:'Report / document',video:'Online video'})[type] || 'Web page'; }
function applyRetrievedMetadata(metadata, note = '') {
  const normalized = { ...metadata };
  normalized.yearDate = normalizeDateInput(metadata.yearDate || metadata.date || '');
  if (!normalized.sourceType || !['website','journal','book','report','video'].includes(normalized.sourceType)) normalized.sourceType = 'website';
  if (normalized.sourceType === 'website' && metadata.journal) normalized.sourceType = 'journal';
  if (!normalized.url) normalized.url = byId('urlInput').value.trim();
  populateForm(normalized);
  const warningText = Array.isArray(metadata.warnings) && metadata.warnings.length ? ` Review: ${metadata.warnings.join(' ')}` : '';
  if (note || warningText) setStatus(`${note || 'Source details loaded.'}${warningText}`, warningText ? 'info' : 'success');
  else setStatus('Source details loaded. Review any missing or uncertain fields.', 'success');
  byId('editorHeading').scrollIntoView({behavior:'smooth',block:'start'});
}
async function scanSource() {
  let url = byId('urlInput').value.trim();
  if (!url) return setStatus('Paste a webpage, DOI, or document URL first.', 'error');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  byId('urlInput').value = url;
  const button = byId('scanButton'); setBusy(button, true, 'Scanning…'); setStatus('Reading the source metadata. This can take a few seconds.', 'info');
  try {
    const data = await requestJson('/api/inspect', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});
    applyRetrievedMetadata(data.metadata || {}, data.note || 'Source details loaded.');
  } catch (error) { setStatus(error.message, 'error'); }
  finally { setBusy(button, false); }
}
async function lookUpDoi() {
  const doi = byId('doiInput').value.trim();
  if (!doi) return setStatus('Enter a DOI first.', 'error');
  const button = byId('doiButton'); setBusy(button, true, 'Looking up…'); setStatus('Searching Crossref for the DOI record.', 'info');
  try {
    const data = await requestJson(`/api/doi?doi=${encodeURIComponent(doi)}`);
    applyRetrievedMetadata(data.metadata || {}, 'Crossref metadata loaded. Confirm title capitalization, authors, and publication details.');
    if (data.metadata?.url) byId('urlInput').value = data.metadata.url;
  } catch (error) { setStatus(error.message, 'error'); }
  finally { setBusy(button, false); }
}
async function searchCrossref() {
  const query = byId('searchInput').value.trim();
  if (query.length < 3) return setStatus('Enter at least 3 characters to search Crossref.', 'error');
  const button = byId('searchButton'); setBusy(button, true, 'Searching…');
  byId('searchResults').innerHTML = '';
  try {
    const data = await requestJson(`/api/search?q=${encodeURIComponent(query)}`);
    if (!data.results?.length) { byId('searchResults').textContent = 'No results found. Try a title phrase or DOI.'; return; }
    byId('searchResults').innerHTML = data.results.map((item, index) => `
      <button class="search-result" type="button" data-result-index="${index}">
        <strong>${escapeHtml(item.title || 'Untitled record')}</strong>
        <span>${escapeHtml((item.authors || []).slice(0,3).join('; ') || 'Author not listed')} · ${escapeHtml((item.yearDate || '').slice(0,4) || 'Date not listed')} · ${escapeHtml(item.journal || item.publisher || item.sourceType || '')}</span>
      </button>`).join('');
    byId('searchResults').querySelectorAll('[data-result-index]').forEach(buttonEl => buttonEl.addEventListener('click', () => {
      const item = data.results[Number(buttonEl.dataset.resultIndex)];
      applyRetrievedMetadata(item, 'Crossref search result loaded. Check the metadata and add page or DOI details if missing.');
    }));
  } catch (error) { setStatus(error.message, 'error'); }
  finally { setBusy(button, false); }
}
function selectFile(file) {
  if (!file) { selectedFile = null; byId('selectedFile').hidden = true; byId('uploadButton').disabled = true; return; }
  selectedFile = file;
  byId('selectedFile').textContent = `${file.name} · ${(file.size / (1024 * 1024)).toFixed(2)} MB`;
  byId('selectedFile').hidden = false;
  byId('uploadButton').disabled = false;
}
async function uploadDocument() {
  if (!selectedFile) return;
  if (selectedFile.size > 15 * 1024 * 1024) return setStatus('That file exceeds the 15 MB upload limit.', 'error');
  const button = byId('uploadButton'); setBusy(button, true, 'Extracting…'); setStatus('Extracting document text and embedded metadata.', 'info');
  try {
    const body = new FormData(); body.append('file', selectedFile);
    const data = await requestJson('/api/upload', {method:'POST',body});
    const metadata = data.metadata || {};
    if (!metadata.title) metadata.title = selectedFile.name.replace(/\.[^.]+$/,'');
    applyRetrievedMetadata(metadata, data.note || 'Document details loaded.');
    if (!metadata.url) byId('urlField').value = '';
    updatePreview();
  } catch (error) { setStatus(error.message, 'error'); }
  finally { setBusy(button, false); }
}
function saveCurrentSource() {
  const source = collectSource();
  if (!source.title) {
    byId('titleField').focus();
    return setStatus('A title is required to add a source.', 'error');
  }
  source.yearDate = normalizeDateInput(source.yearDate);
  source.savedAt = new Date().toISOString();
  const existingIndex = bibliography.findIndex(item => item.id === source.id);
  if (editingId && existingIndex >= 0) bibliography[existingIndex] = source;
  else bibliography.push(source);
  saveBibliography(); renderBibliography();
  editingId = null; byId('draftPill').textContent = 'New citation'; byId('saveButton').innerHTML = 'Add to bibliography <span aria-hidden="true">＋</span>';
  setStatus('Citation saved to your bibliography in this browser.', 'success');
  showToast(existingIndex >= 0 ? 'Citation updated' : 'Citation added to bibliography');
}
function sortedSources(sources) {
  return [...sources].sort((a,b) => {
    const aa = formattedAuthors(a).toLocaleLowerCase() || displayTitle(a).toLocaleLowerCase();
    const bb = formattedAuthors(b).toLocaleLowerCase() || displayTitle(b).toLocaleLowerCase();
    return aa.localeCompare(bb);
  });
}
function renderBibliography() {
  const filter = byId('bibliographySearch').value.trim().toLowerCase();
  const all = sortedSources(bibliography);
  const visible = all.filter(source => `${source.title} ${(source.authors || []).join(' ')} ${source.siteName} ${source.journal} ${source.url}`.toLowerCase().includes(filter));
  byId('sourceCount').textContent = `${bibliography.length} ${bibliography.length === 1 ? 'source' : 'sources'}`;
  byId('exportTxtButton').disabled = !bibliography.length;
  byId('exportHtmlButton').disabled = !bibliography.length;
  byId('clearBibliographyButton').disabled = !bibliography.length;
  if (!visible.length) {
    byId('bibliographyList').innerHTML = filter ? '<div class="empty-state"><strong>No matching sources.</strong><p>Try a different title, author, or website name.</p></div>' : '<div class="empty-state"><span class="empty-state-icon">↳</span><strong>Your sources will collect here.</strong><p>Add the reviewed citation above. The list stays in this browser on this device.</p></div>';
    return;
  }
  byId('bibliographyList').innerHTML = visible.map((source, index) => {
    const ref = makeReference(source);
    const authors = (source.authors || []).join('; ') || 'No author detected';
    return `<article class="bibliography-entry" data-id="${escapeHtml(source.id)}">
      <div class="entry-number">${String(index+1).padStart(2,'0')}</div>
      <div class="entry-body"><div class="entry-meta"><span class="entry-type">${escapeHtml(typeLabel(source.sourceType))}</span><span class="entry-authors">${escapeHtml(authors)}</span></div><div class="entry-reference">${markupToHtml(ref)}</div><div class="entry-intext">In-text: ${markupToHtml(inTextCitation(source))}</div></div>
      <div class="entry-actions"><button type="button" data-action="edit" data-id="${escapeHtml(source.id)}">Edit</button><button type="button" data-action="copy" data-id="${escapeHtml(source.id)}">Copy</button><button type="button" data-action="delete" data-id="${escapeHtml(source.id)}" class="delete-entry">Remove</button></div>
    </article>`;
  }).join('');
  byId('bibliographyList').querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => handleEntryAction(button.dataset.action, button.dataset.id)));
}
function handleEntryAction(action, id) {
  const source = bibliography.find(item => item.id === id);
  if (!source) return;
  if (action === 'edit') {
    populateForm(source);
    byId('editorHeading').scrollIntoView({behavior:'smooth',block:'start'});
  } else if (action === 'copy') copyRichText(makeReference(source), 'Citation copied');
  else if (action === 'delete') {
    bibliography = bibliography.filter(item => item.id !== id); saveBibliography(); renderBibliography(); showToast('Source removed');
    if (editingId === id) clearForm();
  }
}
async function copyRichText(markup, successMessage = 'Copied') {
  const html = markupToHtml(markup);
  const plain = markupToPlain(markup);
  try {
    if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], {type:'text/html'}), 'text/plain': new Blob([plain], {type:'text/plain'}) })]);
    } else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(plain);
    else throw new Error('Clipboard permission is unavailable');
    showToast(successMessage);
  } catch {
    try { await navigator.clipboard.writeText(plain); showToast(successMessage); }
    catch { showToast('Select the citation text and copy it manually'); }
  }
}
function downloadFile(filename, content, type) {
  const blob = new Blob([content], {type}); const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function exportText() {
  const sources = sortedSources(bibliography);
  const content = sources.map(source => markupToPlain(makeReference(source))).join('\n\n');
  downloadFile('CiteRight-APA7-Bibliography.txt', `${content}\n`, 'text/plain;charset=utf-8');
}
function exportHtml() {
  const sources = sortedSources(bibliography);
  const body = sources.map(source => `<p>${markupToHtml(makeReference(source))}</p>`).join('\n');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>APA 7 References</title><style>body{font:12pt/2 Arial,sans-serif;max-width:850px;margin:40px auto;color:#111}h1{font-size:16pt}p{margin:0 0 0 0;text-indent:-.5in;padding-left:.5in;overflow-wrap:anywhere}em{font-style:italic}</style></head><body><h1>References</h1>${body}</body></html>`;
  downloadFile('CiteRight-APA7-Bibliography.html', html, 'text/html;charset=utf-8');
}
async function testApi(target = 'apiStatus') {
  const labelMode = target === 'connectionLabel';
  try {
    const response = await fetch(apiUrl('/health'), {signal:AbortSignal.timeout(8000)});
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error('The backend responded but did not report healthy.');
    if (labelMode) {
      byId('connectionDot').className = 'connection-dot online';
      byId('connectionLabel').textContent = 'API connected';
    } else setStatus(`Connected to ${data.app || 'CiteRight API'} (${apiBase}).`, 'success', target);
    return true;
  } catch (error) {
    if (labelMode) {
      byId('connectionDot').className = 'connection-dot offline';
      byId('connectionLabel').textContent = 'API unavailable';
    } else setStatus(`Could not connect to ${apiBase}. ${error.message || 'Check the URL and deployment.'}`, 'error', target);
    return false;
  }
}
function saveApiBase() {
  const value = trimSlash(byId('apiBaseInput').value);
  if (!value || !/^https?:\/\//i.test(value)) return setStatus('Enter a complete backend URL beginning with https:// (or http:// for local testing).', 'error', 'apiStatus');
  apiBase = value; writeStorage(API_KEY, apiBase); testApi('apiStatus'); testApi('connectionLabel');
}
function resetApiBase() {
  apiBase = currentOrigin(); byId('apiBaseInput').value = apiBase; writeStorage(API_KEY, apiBase); testApi('apiStatus'); testApi('connectionLabel');
}

// Input mode tabs
for (const tab of document.querySelectorAll('[data-tab]')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach(item => { const active = item === tab; item.classList.toggle('is-active', active); item.setAttribute('aria-selected', String(active)); });
    document.querySelectorAll('[data-panel]').forEach(panel => { const active = panel.dataset.panel === tab.dataset.tab; panel.classList.toggle('is-active', active); panel.hidden = !active; });
    setStatus('');
  });
}
byId('scanButton').addEventListener('click', scanSource);
byId('urlInput').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); scanSource(); } });
byId('doiButton').addEventListener('click', lookUpDoi);
byId('doiInput').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); lookUpDoi(); } });
byId('searchButton').addEventListener('click', searchCrossref);
byId('searchInput').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); searchCrossref(); } });
byId('fileInput').addEventListener('change', event => selectFile(event.target.files?.[0]));
byId('uploadButton').addEventListener('click', uploadDocument);
const dropzone = byId('dropzone');
for (const eventName of ['dragenter','dragover']) dropzone.addEventListener(eventName, event => { event.preventDefault(); dropzone.classList.add('is-dragging'); });
for (const eventName of ['dragleave','drop']) dropzone.addEventListener(eventName, event => { event.preventDefault(); dropzone.classList.remove('is-dragging'); });
dropzone.addEventListener('drop', event => selectFile(event.dataTransfer?.files?.[0]));
for (const name of fields) form.elements.namedItem(name)?.addEventListener('input', () => { if (name === 'sourceType') updateTypeFields(); updatePreview(); });
byId('groupAuthor').addEventListener('change', updatePreview);
byId('sentenceCase').addEventListener('change', updatePreview);
byId('saveButton').addEventListener('click', saveCurrentSource);
byId('clearButton').addEventListener('click', () => { clearForm(); setStatus('Fields cleared.', 'info'); });
byId('copyReferenceButton').addEventListener('click', () => { const source = collectSource(); if (!source.title) return showToast('Enter a title first'); copyRichText(makeReference(source), 'APA reference copied'); });
byId('copyInTextButton').addEventListener('click', async () => { const source = collectSource(); if (!source.title) return showToast('Enter a title first'); try { await navigator.clipboard.writeText(markupToPlain(inTextCitation(source))); showToast('In-text citation copied'); } catch { showToast('Clipboard permission is unavailable'); } });
byId('bibliographySearch').addEventListener('input', renderBibliography);
byId('exportTxtButton').addEventListener('click', exportText);
byId('exportHtmlButton').addEventListener('click', exportHtml);
byId('clearBibliographyButton').addEventListener('click', () => {
  if (!confirm('Remove all saved bibliography sources from this browser? This cannot be undone.')) return;
  bibliography = []; saveBibliography(); renderBibliography(); if (editingId) clearForm(); showToast('Bibliography cleared');
});
const settingsDialog = byId('settingsDialog');
byId('settingsButton').addEventListener('click', () => { byId('apiBaseInput').value = apiBase; byId('apiStatus').hidden = true; settingsDialog.showModal(); });
byId('testApiButton').addEventListener('click', () => testApi('apiStatus'));
byId('saveApiButton').addEventListener('click', saveApiBase);
byId('resetApiButton').addEventListener('click', resetApiBase);

// Keep generated previews current when the page is opened without any prior sources.
renderBibliography();
updateTypeFields();
updatePreview();
testApi('connectionLabel');
