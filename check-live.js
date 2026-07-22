// Verifica se algum canal de YouTube da lista "canais" esta transmitindo AO VIVO agora.
// Roda via GitHub Actions (.github/workflows/check-live.yml), sem chave de API:
// usa o atalho https://www.youtube.com/@handle/live, que o proprio YouTube
// redireciona para o video ao vivo quando existe uma transmissao rolando.
// Sinal confiavel = "isLiveNow":true no HTML (isLiveBroadcast sozinho engana,
// ele fica true ate em videos antigos que um dia foram transmitidos ao vivo).

const fs = require('fs');

// Mesmos ids/nomes do array "canais" no index.html — mantenha em sincronia
// ao adicionar/remover canais de YouTube na aba Vendedores/Lives/Leiloes.
const CANAIS_YOUTUBE = [
  { id: 1, n: 'Diego Sheth', handle: 'DiegoSheth' },
  { id: 2, n: 'Antec.r', handle: 'antec.r' },
  { id: 3, n: 'Garimpo dos Games', handle: 'Garimpodosgames' },
  { id: 4, n: 'Cara de Barata', handle: 'caradebarata' },
  { id: 5, n: 'DJ Games Retro', handle: 'djgamesretro' },
  { id: 6, n: 'Jotape Arcade', handle: 'JotapeArcade' },
  { id: 7, n: 'Sigchap', handle: 'sigchap' },
  { id: 9, n: 'Rodrigo Retro Games', handle: 'RodrigoRetroGames' },
  { id: 12, n: 'VG Invest', handle: 'vginvest' },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function extract(html, regex) {
  const m = html.match(regex);
  return m ? m[1] : '';
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .trim();
}

async function checarCanal(canal) {
  try {
    const res = await fetch(`https://www.youtube.com/@${canal.handle}/live`, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'pt-BR,pt;q=0.9',
        // Sem esse cookie, o YouTube às vezes responde com a pagina de consentimento
        // de cookies em vez da pagina do canal (comum em datacenters/CI) — isso faz
        // a checagem de live falhar silenciosamente (nunca acha "isLiveNow":true).
        'Cookie': 'CONSENT=YES+1; SOCS=CAI'
      }
    });
    if (!res.ok) return null;
    const html = await res.text();

    if (html.includes('consent.youtube.com') || html.includes('Before you continue')) {
      console.warn(`Aviso: pagina de consentimento do YouTube retornada para ${canal.n} — pulando.`);
      return null;
    }

    const isLiveNow = html.includes('"isLiveNow":true');
    console.log(`[debug] ${canal.n}: status=${res.status} tamanhoHtml=${html.length} isLiveNow=${isLiveNow}`);
    if (!isLiveNow) return null;

    const canonical = extract(html, /<link rel="canonical" href="([^"]+)">/);
    const videoId = extract(canonical, /[?&]v=([^&]+)/) || extract(html, /"videoId":"([^"]+)"/);
    let videoTitle = decodeEntities(extract(html, /<title>([^<]*)<\/title>/)).replace(/ - YouTube$/, '');
    if (!videoTitle) videoTitle = canal.n;

    return {
      id: canal.id,
      n: canal.n,
      videoId,
      videoTitle,
      videoUrl: videoId ? `https://www.youtube.com/watch?v=${videoId}` : `https://www.youtube.com/@${canal.handle}/live`,
      thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : ''
    };
  } catch (e) {
    console.error(`Erro checando ${canal.n}:`, e.message);
    return null;
  }
}

async function main() {
  const resultados = await Promise.all(CANAIS_YOUTUBE.map(checarCanal));
  const live = resultados.filter(Boolean);

  const payload = {
    updated: new Date().toISOString(),
    live
  };

  fs.writeFileSync('canais_live.json', JSON.stringify(payload, null, 2) + '\n');
  console.log(`OK: ${live.length} canal(is) ao vivo agora.`);
  live.forEach(c => console.log(` - ${c.n}: ${c.videoTitle}`));
}

main().catch(err => {
  console.error('Erro ao checar lives:', err);
  process.exit(1);
});
