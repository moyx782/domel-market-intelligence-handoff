// Automatic OCR for downloadable PDFs/images discovered on an event.
//
// Enrichment records document links + availability only (it never downloads a
// file just because a page links to it). After enrichment, this policy selects
// the downloadable OCR-able documents and the task runner queues document.parse
// for them — the "provided PDF → direct OCR" path. Humans can still queue any
// document manually from the event detail panel.
//
// Cost guards: max N per event, skip already parsed/materials, only direct
// downloadable files. Disable with AUTO_OCR_DOCUMENTS=0.

const OCR_DOCUMENT_RE = /\.(pdf|png|jpe?g|webp|tiff?)(?:$|[?#])/i;

export function selectDocumentsForOcr(event, {max = 3} = {}) {
 const existingMaterials = new Set((event?.materials ?? []).map(material => material.url).filter(Boolean));
 const documents = Array.isArray(event?.documents) ? event.documents : [];
 return documents
  .filter(document => document && document.status === 'downloadable')
  .filter(document => !document.parseProvider && !document.parsedAt)
  .filter(document => OCR_DOCUMENT_RE.test(String(document.url || '')))
  .filter(document => !existingMaterials.has(document.url))
  .slice(0, Math.max(0, Number(max) || 0));
}
