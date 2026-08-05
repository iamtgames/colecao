// Indexa as URLs de produto das lojas de games parceiras (SOMENTE URL + slug,
// sem preco) a partir dos sitemaps oficiais de cada loja. Gera catalogo_urls.json,
// que o Worker de busca de precos usa pra descobrir rapidamente quais paginas
// de produto podem bater com o termo digitado pelo usuario, antes de buscar o
// preco de verdade (ao vivo) so nas paginas que realmente batem.
//
// Por que so URL+slug aqui, sem visitar cada pagina de produto:
// as lojas "Loja Integrada" bloqueiam /buscar e /api/ no robots.txt (nao
// bloqueiam paginas de produto individuais, nem o sitemap - que existe
// exatamente pra ser lido por robos). Baixar todo o catalogo (as vezes
// milhares de produtos) toda hora violaria o Crawl-delay delas. Em vez disso
// baixamos so os sitemaps (leves, pensados pra isso) uma vez por dia, e
// deixamos a busca do PRECO de verdade acontecer ao vivo, na hora, so pros
// poucos produtos que batem com o que o usuario digitou (isso e feito pelo
// Worker, nao por este script).
//
// Roda via GitHub Actions (.github/workflows/catalogo-urls.yml), 1x por dia.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SAIDA = path.join(__dirname, '..', 'catalogo_urls.json');

const LOJAS = [
  { id: 'carvalhogames', nome: 'Carvalho Games', dominio: 'https://www.carvalhogames.com.br', plataforma: 'lojaintegrada' },
  { id: 'meugameusado', nome: 'Meu Game Usado', dominio: 'https://www.meugameusado.com.br', plataforma: 'lojaintegrada' },
  { id: 'gamerhut', nome: 'Gamerhut', dominio: 'https://www.gamerhut.com.br', plataforma: 'lojaintegrada' },
  { id: 'shopb', nome: 'ShopB', dominio: 'https://www.shopb.com.br', plataforma: 'lojaintegrada' },
  { id: 'maicongames', nome: 'Maicon Games', dominio: 'https://www.maicongames.com.br', plataforma: 'lojaintegrada' },
  { id: 'silvioplay', nome: 'Silvio Play Games', dominio: 'https://silvioplay-games.lojaintegrada.com.br', plataforma: 'lojaintegrada' },
  { id: 'fitagames', nome: 'Fita Games', dominio: 'https://www.fitagames.com.br', plataforma: 'lojaintegrada' },
  { id: 'lunnagames', nome: 'Lunna Games', dominio: 'https://lunnagames.com.br', plataforma: 'nuvemshop' },
  { id: 'playgorila', nome: 'Play Gorila', dominio: 'https://www.playgorila.com', plataforma: 'nuvemshop' }
];

const CABECALHO = {
  'User-Agent': 'Mozilla/5.0 (compatible; ColecaoIamTBot/1.0; +https://iamtgames.github.io/colecao/)'
};

function pausar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function buscarTexto(url) {
  const res = await fetch(url, { headers: CABECALHO });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return res.text();
}

async function buscarBufferDescomprimido(url) {
  const res = await fetch(url, { headers: CABECALHO });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  // Sitemaps da Nuvemshop vem .gz; se nao vier comprimido (raro), cai no catch.
  try {
    return zlib.gunzipSync(buffer).toString('utf8');
  } catch (e) {
    return buffer.toString('utf8');
  }
}

function extrairLocs(xml) {
  const locs = [];
  const regex = /<loc>([^<]+)<\/loc>/g;
  let m;
  while ((m = regex.exec(xml)) !== null) {
    locs.push(m[1].trim());
  }
  return locs;
}

function slugParaTexto(url) {
  try {
    const u = new URL(url);
    let ultimo = u.pathname.split('/').filter(Boolean).pop() || '';
    ultimo = ultimo.replace(/\.html?$/i, '');
    return ultimo.replace(/[-_]+/g, ' ').trim().toLowerCase();
  } catch (e) {
    return '';
  }
}

// Filtra fora paginas obviamente nao-produto (categorias, marcas, paginas institucionais)
function pareceProduto(url, dominio) {
  const caminho = url.replace(dominio, '');
  if (caminho === '' || caminho === '/') return false;
  if (/\/pagina\//.test(caminho)) return false;
  if (/\/(nintendo|playstation|xbox|lancamentos|em-breve|novidades|amiibo)\/?$/i.test(caminho)) return false;
  return true;
}

async function indexarLojaIntegrada(loja) {
  const produtos = [];
  const indiceXml = await buscarTexto(`${loja.dominio}/sitemap.xml`);
  // sitemapindex aponta pra varios sitemap/product-N.xml, brand-N.xml, category-N.xml etc.
  const sitemapsFilhos = extrairLocs(indiceXml).filter(u => /\/sitemap\/product-\d+\.xml$/.test(u));
  for (const sitemapUrl of sitemapsFilhos) {
    try {
      const xml = await buscarTexto(sitemapUrl);
      const urls = extrairLocs(xml);
      for (const url of urls) {
        if (!pareceProduto(url, loja.dominio)) continue;
        produtos.push({ loja: loja.id, url, texto: slugParaTexto(url) });
      }
    } catch (e) {
      console.warn(`Aviso: falha ao ler ${sitemapUrl}: ${e.message}`);
    }
    await pausar(400);
  }
  return produtos;
}

async function indexarNuvemshop(loja) {
  const produtos = [];
  const robots = await buscarTexto(`${loja.dominio}/robots.txt`);
  const linhaSitemap = robots.split('\n').find(l => /^sitemap:/i.test(l.trim()) && /sitemap\.xml\.gz$/i.test(l));
  if (!linhaSitemap) {
    console.warn(`Aviso: nao achei sitemap.xml.gz no robots.txt de ${loja.dominio}`);
    return produtos;
  }
  const sitemapUrl = linhaSitemap.split(/:\s*/).slice(1).join(':').trim();
  const xml = await buscarBufferDescomprimido(sitemapUrl);
  const urls = extrairLocs(xml);
  for (const url of urls) {
    // Nuvemshop usa /produtos/<slug> (padrao br) pras paginas de produto.
    if (!/\/produtos\//.test(url)) continue;
    produtos.push({ loja: loja.id, url, texto: slugParaTexto(url) });
  }
  return produtos;
}

async function main() {
  const todosProdutos = [];
  for (const loja of LOJAS) {
    console.log(`Indexando ${loja.nome}...`);
    try {
      const produtos = loja.plataforma === 'nuvemshop'
        ? await indexarNuvemshop(loja)
        : await indexarLojaIntegrada(loja);
      console.log(`  -> ${produtos.length} produtos encontrados`);
      todosProdutos.push(...produtos);
    } catch (e) {
      console.warn(`Aviso: falha ao indexar ${loja.nome}: ${e.message}`);
    }
    await pausar(500);
  }

  const payload = {
    updated: new Date().toISOString(),
    lojas: LOJAS.map(({ id, nome, dominio, plataforma }) => ({ id, nome, dominio, plataforma })),
    produtos: todosProdutos
  };

  fs.writeFileSync(SAIDA, JSON.stringify(payload));
  console.log(`OK: ${todosProdutos.length} produtos indexados de ${LOJAS.length} lojas.`);
}

main().catch(err => {
  console.error('Erro ao indexar catalogo:', err);
  process.exit(1);
});
