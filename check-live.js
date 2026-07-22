// Verifica se algum canal de YouTube da lista "canais" esta transmitindo AO VIVO agora.
// Roda via GitHub Actions (.github/workflows/check-live.yml).
//
// Usa a API oficial do YouTube Data API v3 (chave em process.env.YOUTUBE_API_KEY,
// guardada como secret do GitHub Actions — nunca aparece no codigo nem no site).
//
// Por que trocamos a raspagem de HTML por essa abordagem:
// tentamos antes raspar https://www.youtube.com/@handle/live direto, mas o YouTube
// bloqueia requisicoes vindas de IPs de datacenter (como os runners do GitHub Actions)
// com um erro "LOGIN_REQUIRED" especificamente em alguns canais/lives, mesmo quando
// a transmissao esta genuinamente ao vivo (confirmado manualmente via navegador).
// A API oficial nao sofre esse bloqueio e da a resposta correta sempre.
//
// Estrategia pra gastar pouca cota (limite gratuito: 10.000 unidades/dia):
// 1) Pra cada canal, busca o feed RSS publico (gratis, sem chave, sem cota) em
//    https://www.youtube.com/feeds/videos.xml?channel_id=... e pega os 3 videos
//    mais recentes (o suficiente pra pegar uma live mesmo que nao seja a ultima
//    postagem, como aconteceu com o canal Sig Chap).
// 2) Junta os ids de video de TODOS os canais numa unica chamada videos.list
//    (part=snippet), que custa so ~2 unidades no total, nao importa quantos ids
//    (ate 50) — MUITO mais barato que 1 chamada search.list por canal (100
//    unidades cada, o que estouraria a cota rodando a cada 10 minutos).
// 3) Filtra quem tem snippet.liveBroadcastContent === 'live'.

const fs = require('fs');

const API_KEY = process.env.YOUTUBE_API_KEY;

// Mesmos ids/nomes do array "canais" no index.html — mantenha em sincronia
// ao adicionar/remover canais de YouTube na aba Vendedores/Lives/Leiloes.
// channelId (UC...) resolvido uma vez via API (channels.list?forHandle=) e
// fixado aqui pra nao gastar cota resolvendo handle -> id toda hora.
const CANAIS_YOUTUBE = [
  { id: 1, n: 'Diego Sheth', channelId: 'UC6ZRxYOOJw2rwtuIerO-lrA' },
  { id: 2, n: 'Antec.r', channelId: 'UCWX9kXOO4awp-c3VeJtObPw' },
  { id: 3, n: 'Garimpo dos Games', channelId: 'UCkDTuzfIG3s_Z-JSoHw3IZQ' },
  { id: 4, n: 'Cara de Barata', channelId: 'UCefKgYBOrc3yff2gkhgslcQ' },
  { id: 5, n: 'DJ Games Retro', channelId: 'UC1yok96pYoUNtNnyN7zzWPQ' },
  { id: 6, n: 'Jotape Arcade', channelId: 'UCDoeapAROOAnkBwd178MpUQ' },
  { id: 7, n: 'Sigchap', channelId: 'UCpTyn0RRvTmjgNi7YYzUstA' },
  { id: 9, n: 'Rodrigo Retro Games', channelId: 'UChKgfyQRLATKl7dl-z6tolg' },
  { id: 12, n: 'VG Invest', channelId: 'UCEHV0ePP26xJVcPEoCLxfSQ' },
];

const MAX_VIDEOS_POR_CANAL = 3;

async function pegarVideosRecentes(canal) {
  try {
    const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${canal.channelId}`);
    if (!res.ok) {
      console.warn(`Aviso: feed RSS falhou pra ${canal.n} (status ${res.status})`);
      return [];
    }
    const xml = await res.text();
    const ids = Array.from(xml.matchAll(/<yt:videoId>([^<]+)<\/yt:videoId>/g))
      .map(m => m[1])
      .slice(0, MAX_VIDEOS_POR_CANAL);
    return ids.map(videoId => ({ videoId, canal }));
  } catch (e) {
    console.error(`Erro buscando feed RSS de ${canal.n}:`, e.message);
    return [];
  }
}

async function main() {
  if (!API_KEY) {
    throw new Error('YOUTUBE_API_KEY nao configurada (secret do GitHub Actions ausente).');
  }

  const listasPorCanal = await Promise.all(CANAIS_YOUTUBE.map(pegarVideosRecentes));
  const candidatos = listasPorCanal.flat();

  if (!candidatos.length) {
    throw new Error('Nenhum video encontrado via RSS pra nenhum canal — abortando pra nao sobrescrever canais_live.json com lista vazia por engano.');
  }

  const idParaCanal = {};
  candidatos.forEach(c => { idParaCanal[c.videoId] = c.canal; });
  const idsUnicos = Object.keys(idParaCanal);

  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${idsUnicos.join(',')}&key=${API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  if (data.error) {
    throw new Error(`Erro da API do YouTube: ${data.error.message}`);
  }

  const live = (data.items || [])
    .filter(v => v.snippet.liveBroadcastContent === 'live')
    .map(v => {
      const canal = idParaCanal[v.id];
      return {
        id: canal.id,
        n: canal.n,
        videoId: v.id,
        videoTitle: v.snippet.title,
        videoUrl: `https://www.youtube.com/watch?v=${v.id}`,
        thumbnail: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`
      };
    });

  const payload = {
    updated: new Date().toISOString(),
    live
  };

  fs.writeFileSync('canais_live.json', JSON.stringify(payload, null, 2) + '\n');
  console.log(`OK: ${idsUnicos.length} videos checados via API, ${live.length} canal(is) ao vivo agora.`);
  live.forEach(c => console.log(` - ${c.n}: ${c.videoTitle}`));
}

main().catch(err => {
  console.error('Erro ao checar lives:', err);
  process.exit(1);
});
