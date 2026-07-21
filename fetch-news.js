// Busca o feed RSS do Flow Games (flowgames.gg) e gera news.json na raiz do repo.
// Roda automaticamente via GitHub Actions (.github/workflows/update-news.yml),
// sem intervencao manual — o fetch client-side direto falha por CORS (RSS nao
// costuma liberar Access-Control-Allow-Origin), entao a busca acontece aqui,
// do lado do servidor do Actions, e o site le o news.json (mesma origem).

const fs = require('fs');

const FEED_URL = 'https://flowgames.gg/feed/';
const MAX_ITEMS = 10;

function decodeEntities(str) {
  return str
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .trim();
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

function extractImage(block) {
  const contentEncoded = block.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/i);
  const searchIn = contentEncoded ? contentEncoded[1] : block;
  const imgMatch = searchIn.match(/<img[^>]+src=["']([^"']+)["']/i);
  return imgMatch ? imgMatch[1] : '';
}

async function main() {
  const res = await fetch(FEED_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ColecaoIamTBot/1.0; +https://iamtgames.github.io/colecao/)' }
  });
  if (!res.ok) throw new Error(`Falha ao buscar feed: HTTP ${res.status}`);
  const xml = await res.text();

  const blocks = xml.split(/<item>/i).slice(1).map(b => b.split(/<\/item>/i)[0]);
  const items = [];

  for (const block of blocks.slice(0, MAX_ITEMS)) {
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    const pubDate = extractTag(block, 'pubDate');
    const image = extractImage(block);
    if (title && link) {
      items.push({ title, link, pubDate, image });
    }
  }

  if (!items.length) {
    throw new Error('Nenhum item encontrado no feed — abortando para nao sobrescrever news.json com lista vazia.');
  }

  const payload = {
    fonte: 'Flow Games (flowgames.gg)',
    updated: new Date().toISOString(),
    items
  };

  fs.writeFileSync('news.json', JSON.stringify(payload, null, 2) + '\n');
  console.log(`OK: ${items.length} noticias salvas em news.json`);
}

main().catch(err => {
  console.error('Erro ao atualizar noticias:', err);
  process.exit(1);
});
