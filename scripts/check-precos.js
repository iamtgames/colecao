// Checa o menor preco anunciado no Mercado Livre pra cada jogo do Radar de Caca
// (array "wishlist" dentro do index.html) e gera precos.json.
// Roda via GitHub Actions (.github/workflows/check-precos.yml).
//
// Por que ler o wishlist direto do index.html em vez de duplicar a lista aqui:
// o Radar de Caca tem 100 itens com texto de "motivo" — manter duas copias
// dessa lista (uma no site, outra no script) seria um convite a desincronizar.
// Em vez disso, extraimos o array "const wishlist = [...]" direto do HTML.
//
// API usada: busca publica do Mercado Livre (site MLB), sem necessidade de
// chave/autenticacao: https://api.mercadolibre.com/sites/MLB/search
//
// Como os itens do Radar de Caca sao edicoes de colecionador raras, a busca
// por nome pode trazer anuncios que nao sao exatamente a mesma edicao (afinal
// e um catalogo publico e aberto) — por isso o preco encontrado deve ser
// tratado como uma referencia ("menor preco anunciado agora"), nao uma
// garantia de que e exatamente aquele item. O link levado ao anuncio mais
// barato deixa o usuario conferir antes de comprar.

const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const PRECOS_PATH = path.join(__dirname, '..', 'precos.json');

const LOTE = 5; // buscas simultaneas por vez, pra nao sobrecarregar a API publica
const PAUSA_ENTRE_LOTES_MS = 300;

function extrairWishlist(){
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const inicio = html.indexOf('const wishlist = [');
  if(inicio === -1){
    throw new Error('Nao encontrei "const wishlist = [" no index.html — o Radar de Caca mudou de formato?');
  }
  const fimMarcador = html.indexOf('\n];', inicio);
  if(fimMarcador === -1){
    throw new Error('Nao encontrei o fechamento do array wishlist no index.html.');
  }
  const trecho = html.slice(inicio, fimMarcador + 3);
  const arrayLiteral = trecho.slice(trecho.indexOf('['));
  // eslint-disable-next-line no-new-func
  const wishlist = new Function(`return ${arrayLiteral}`)();
  if(!Array.isArray(wishlist) || !wishlist.length){
    throw new Error('Array wishlist extraido veio vazio ou invalido.');
  }
  return wishlist;
}

function carregarPrecosAnteriores(){
  try{
    const json = JSON.parse(fs.readFileSync(PRECOS_PATH, 'utf8'));
    const mapa = {};
    (json.itens || []).forEach(it => { mapa[`${it.n}|${it.plat}`] = it.precoMin; });
    return mapa;
  }catch(e){
    return {}; // primeira execucao, ainda sem historico
  }
}

async function buscarPrecoItem(item){
  try{
    const termo = encodeURIComponent(`${item.n} ${item.plat}`);
    const url = `https://api.mercadolibre.com/sites/MLB/search?q=${termo}&limit=5`;
    const res = await fetch(url);
    if(!res.ok) return null;
    const data = await res.json();
    const resultados = (data.results || []).filter(r => typeof r.price === 'number' && r.price > 0);
    if(!resultados.length) return null;
    resultados.sort((a, b) => a.price - b.price);
    const melhor = resultados[0];
    return {
      n: item.n,
      plat: item.plat,
      precoMin: melhor.price,
      url: melhor.permalink || null,
      tituloAnuncio: melhor.title || null
    };
  }catch(e){
    console.warn(`Aviso: falha ao buscar preco de "${item.n}": ${e.message}`);
    return null;
  }
}

function dividirEmLotes(lista, tamanho){
  const lotes = [];
  for(let i = 0; i < lista.length; i += tamanho) lotes.push(lista.slice(i, i + tamanho));
  return lotes;
}

function pausar(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function diagnosticoRapido(item){
  try{
    const termo = encodeURIComponent(`${item.n} ${item.plat}`);
    const url = `https://api.mercadolibre.com/sites/MLB/search?q=${termo}&limit=5`;
    const res = await fetch(url);
    const texto = await res.text();
    console.log(`DIAGNOSTICO: status=${res.status} url=${url}`);
    console.log(`DIAGNOSTICO: corpo (primeiros 500 chars) = ${texto.slice(0, 500)}`);
  }catch(e){
    console.log(`DIAGNOSTICO: erro de rede - ${e.message}`);
  }
}

async function main(){
  const wishlist = extrairWishlist();
  await diagnosticoRapido(wishlist[0]);
  const precosAnteriores = carregarPrecosAnteriores();

  const lotes = dividirEmLotes(wishlist, LOTE);
  const itens = [];
  for(const lote of lotes){
    const resultados = await Promise.all(lote.map(buscarPrecoItem));
    resultados.forEach(r => { if(r) itens.push(r); });
    await pausar(PAUSA_ENTRE_LOTES_MS);
  }

  itens.forEach(it => {
    const chave = `${it.n}|${it.plat}`;
    const precoAnterior = precosAnteriores[chave];
    it.precoAnterior = precoAnterior !== undefined ? precoAnterior : null;
    it.caiu = precoAnterior !== undefined && it.precoMin < precoAnterior;
  });

  const payload = {
    updated: new Date().toISOString(),
    itens
  };

  fs.writeFileSync(PRECOS_PATH, JSON.stringify(payload, null, 2) + '\n');
  const qtdCaiu = itens.filter(i => i.caiu).length;
  console.log(`OK: ${itens.length}/${wishlist.length} precos encontrados no Mercado Livre. ${qtdCaiu} caíram desde a última checagem.`);
}

main().catch(err => {
  console.error('Erro ao checar precos:', err);
  process.exit(1);
});
