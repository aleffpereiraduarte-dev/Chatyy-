// components/chat/nativeEmojiData.js — [2026-10-15 native-ctxmenu]
//
// Grade de emojis do menu de contexto NATIVO (botão "+" da barra de reações).
// Emojis são CONTEÚDO (reação), não ícone de UI — por isso emoji real aqui.
// Cada item: 'emoji palavras-chave…' (pt + en, minúsculas, sem acento) — o
// nativo busca por substring nas palavras. O título da categoria vem do i18n
// (tk) com fallback pt-BR (fb). Mandado ao nativo UMA vez por sessão
// (o nativo guarda num cache estático).

const C = (tk, fb, list) => ({ tk, fb, list });

export const EMOJI_CATS = [
  C('chatConv.emojiSmileys', 'Carinhas', [
    '😀 sorriso feliz smile happy grin', '😃 sorriso feliz smile happy', '😄 sorriso rindo smile laugh', '😁 sorriso dentes grin',
    '😆 rindo risada laugh', '😅 suor nervoso sweat nervous', '😂 rindo chorando kkk lol laugh tears', '🤣 rolando rindo kkk rofl',
    '🥲 sorriso lagrima smile tear', '☺️ sorriso fofo smile', '😊 sorriso corado blush smile', '😇 anjo inocente angel halo',
    '🙂 sorriso leve slight smile', '🙃 de cabeca para baixo upside down', '😉 piscada wink', '😌 aliviado relieved',
    '😍 apaixonado coracao olhos love heart eyes', '🥰 apaixonado coracoes love hearts', '😘 beijo kiss', '😗 beijo kiss',
    '😙 beijo kiss', '😚 beijo kiss', '😋 delicia gostoso yum', '😛 lingua tongue', '😝 lingua tongue', '😜 piscada lingua wink tongue',
    '🤪 doido maluco crazy zany', '🤨 desconfiado sobrancelha suspicious', '🧐 monoculo analisando monocle', '🤓 nerd geek',
    '😎 oculos legal cool sunglasses', '🥸 disfarce disguise', '🤩 estrelas uau star struck wow', '🥳 festa aniversario party',
    '😏 malicioso smirk', '😒 entediado unamused', '😞 decepcionado disappointed', '😔 pensativo triste pensive sad',
    '😟 preocupado worried', '😕 confuso confused', '🙁 triste sad frown', '☹️ triste sad frown', '😣 persistente persevere',
    '😖 confuso confounded', '😫 cansado tired', '😩 exausto weary', '🥺 por favor pidao pleading', '😢 chorando triste cry sad',
    '😭 chorando muito sob cry', '😤 bufando triumph huff', '😠 bravo raiva angry', '😡 furioso raiva rage angry', '🤬 xingando palavrao cursing',
    '🤯 cabeca explodindo mind blown', '😳 envergonhado corado flushed', '🥵 calor hot', '🥶 frio cold', '😱 grito medo scream fear',
    '😨 medo fearful', '😰 ansioso anxious', '😥 aliviado triste sad relieved', '😓 suor sweat', '🤗 abraco hug', '🤔 pensando thinking hmm',
    '🫡 continencia salute', '🤭 ops mao boca oops giggle', '🫢 surpreso mao boca gasp', '🤫 silencio shh', '🤥 mentiroso liar',
    '😶 sem palavras speechless', '😐 neutro neutral', '😑 sem expressao expressionless', '😬 careta grimace', '🫠 derretendo melting',
    '🙄 revirando olhos eye roll', '😯 surpreso hushed', '😦 assustado frowning', '😧 angustiado anguished', '😮 surpreso wow open mouth',
    '😲 espantado astonished', '🥱 bocejo sono yawn', '😴 dormindo sono sleep zzz', '🤤 babando drool', '😪 sonolento sleepy',
    '😵 tonto dizzy', '🤐 boca fechada zipper', '🥴 grogue woozy', '🤢 enjoado nausea', '🤮 vomitando vomit', '🤧 espirro gripe sneeze',
    '😷 mascara doente mask sick', '🤒 febre doente fever sick', '🤕 machucado hurt', '🤑 dinheiro money', '🤠 cowboy vaqueiro',
    '😈 diabinho devil', '👿 diabo bravo devil', '👻 fantasma ghost', '💀 caveira morri skull dead', '☠️ caveira skull', '💩 coco poop',
    '🤡 palhaco clown', '👹 ogro ogre', '👽 alien et', '🤖 robo robot', '🎃 abobora halloween pumpkin', '😺 gato sorrindo cat',
    '😸 gato rindo cat', '😹 gato chorando rindo cat', '😻 gato apaixonado cat love', '🙈 macaco nao vejo monkey see', '🙉 macaco nao ouco monkey hear', '🙊 macaco nao falo monkey speak',
  ]),
  C('chatConv.emojiGestures', 'Gestos', [
    '👍 joinha curti like ok thumbs up', '👎 nao curti dislike thumbs down', '👌 ok perfeito ok hand', '🤌 italiano pinched',
    '🤏 pouquinho pinch', '✌️ paz vitoria peace victory', '🤞 dedos cruzados sorte fingers crossed luck', '🫰 coracao dedos money heart',
    '🤟 te amo love you', '🤘 rock metal', '🤙 me liga call me', '👈 esquerda left', '👉 direita right', '👆 cima up', '👇 baixo down',
    '☝️ um apontando point up', '✋ mao pare hand stop', '🤚 mao hand', '🖐️ mao hand', '🖖 vulcano spock', '👋 tchau oi wave hi bye',
    '🫶 coracao maos heart hands', '👏 palmas aplausos clap', '🙌 celebrando aleluia raise hands', '👐 maos abertas open hands', '🤲 maos palmas palms',
    '🤝 acordo aperto de mao handshake deal', '🙏 por favor obrigado reza amem pray thanks please', '✊ punho fist', '👊 soco fist bump',
    '🤛 soco esquerda fist', '🤜 soco direita fist', '💪 forca musculo strong muscle', '🦾 braco robo arm', '✍️ escrevendo writing',
    '💅 unhas esmalte nails', '🤳 selfie', '👀 olhos olhando eyes look', '👁️ olho eye', '🧠 cerebro brain', '👄 boca lips', '💋 beijo batom kiss lips',
    '🫂 abraco hug people', '👶 bebe baby', '🧒 crianca child', '👦 menino boy', '👧 menina girl', '🧑 pessoa person', '👨 homem man', '👩 mulher woman',
    '🧓 idoso older', '👴 vovo grandpa', '👵 vovo grandma', '🙋 levantando mao raising hand', '🤷 sei la nao sei shrug', '🤦 facepalm vergonha',
    '🙇 reverencia bow', '💁 informacao tipping hand', '🙅 nao no gesture', '🙆 ok gesture', '🏃 correndo running', '💃 dancando danca dance',
    '🕺 dancando dance', '👯 festa party dancers', '🧘 meditando yoga', '👑 coroa rei rainha crown king queen', '🎓 formatura graduation',
  ]),
  C('chatConv.emojiHearts', 'Corações', [
    '❤️ coracao amor vermelho heart love red', '🧡 coracao laranja orange heart', '💛 coracao amarelo yellow heart', '💚 coracao verde green heart',
    '💙 coracao azul blue heart', '💜 coracao roxo purple heart', '🖤 coracao preto black heart', '🤍 coracao branco white heart',
    '🤎 coracao marrom brown heart', '🩷 coracao rosa pink heart', '🩵 coracao azul claro light blue heart', '🩶 coracao cinza grey heart',
    '💔 coracao partido broken heart', '❤️‍🔥 coracao pegando fogo heart fire', '❤️‍🩹 coracao curando mending heart', '❣️ coracao exclamacao heart',
    '💕 dois coracoes two hearts', '💞 coracoes girando revolving hearts', '💓 coracao batendo beating heart', '💗 coracao crescendo growing heart',
    '💖 coracao brilhando sparkling heart', '💘 coracao flecha cupido cupid', '💝 coracao presente gift heart', '💟 coracao decoracao heart',
    '💌 carta de amor love letter', '😻 gato apaixonado cat love', '🫀 coracao anatomico anatomical heart', '💑 casal couple', '💏 beijo casal kiss couple',
  ]),
  C('chatConv.emojiAnimals', 'Animais e natureza', [
    '🐶 cachorro cao dog', '🐱 gato cat', '🐭 rato mouse', '🐹 hamster', '🐰 coelho rabbit bunny', '🦊 raposa fox', '🐻 urso bear',
    '🐼 panda', '🐨 coala koala', '🐯 tigre tiger', '🦁 leao lion', '🐮 vaca cow', '🐷 porco pig', '🐸 sapo frog', '🐵 macaco monkey',
    '🐔 galinha chicken', '🐧 pinguim penguin', '🐦 passaro bird', '🐤 pintinho chick', '🦆 pato duck', '🦅 aguia eagle', '🦉 coruja owl',
    '🦄 unicornio unicorn', '🐝 abelha bee', '🦋 borboleta butterfly', '🐌 caracol lesma snail', '🐞 joaninha ladybug', '🐢 tartaruga turtle',
    '🐍 cobra snake', '🦖 dinossauro dinosaur', '🐙 polvo octopus', '🦈 tubarao shark', '🐬 golfinho dolphin', '🐳 baleia whale', '🐠 peixe fish',
    '🦒 girafa giraffe', '🐘 elefante elephant', '🦓 zebra', '🐴 cavalo horse', '🐑 ovelha sheep', '🐐 cabra goat', '🐈 gato cat', '🐕 cachorro dog',
    '🌵 cacto cactus', '🌲 arvore tree', '🌴 palmeira coqueiro palm', '🍀 trevo sorte clover luck', '🌱 broto planta seedling', '🌿 erva herb',
    '🍁 folha outono maple', '🍂 folhas fallen leaves', '🌷 tulipa tulip flower', '🌹 rosa rose flower', '🌻 girassol sunflower', '🌸 flor cerejeira blossom',
    '💐 buque flores bouquet', '🌺 flor hibisco hibiscus', '🌼 flor flower', '🌞 sol sun', '🌝 lua moon', '🌙 lua moon', '⭐ estrela star',
    '🌟 estrela brilhante glowing star', '✨ brilho sparkles', '⚡ raio energia lightning', '🔥 fogo foguinho top fire lit hot', '🌈 arco iris rainbow',
    '☀️ sol sun', '⛅ nublado cloud sun', '☁️ nuvem cloud', '🌧️ chuva rain', '⛈️ tempestade storm', '❄️ neve snow', '☃️ boneco de neve snowman',
    '🌊 onda mar wave ocean', '💧 gota drop', '🌍 terra mundo earth world', '🌎 terra mundo americas world',
  ]),
  C('chatConv.emojiFood', 'Comida e bebida', [
    '🍏 maca verde apple', '🍎 maca apple', '🍐 pera pear', '🍊 laranja orange', '🍋 limao lemon', '🍌 banana', '🍉 melancia watermelon',
    '🍇 uva grapes', '🍓 morango strawberry', '🫐 mirtilo blueberry', '🍒 cereja cherry', '🍑 pessego peach', '🥭 manga mango', '🍍 abacaxi pineapple',
    '🥥 coco coconut', '🥝 kiwi', '🍅 tomate tomato', '🥑 abacate avocado', '🍆 berinjela eggplant', '🌶️ pimenta pepper hot', '🌽 milho corn',
    '🥕 cenoura carrot', '🥦 brocolis broccoli', '🧄 alho garlic', '🧅 cebola onion', '🥔 batata potato', '🍞 pao bread', '🥐 croissant',
    '🧀 queijo cheese', '🥚 ovo egg', '🍳 ovo frito cozinhar cooking', '🥓 bacon', '🥩 carne churrasco meat steak', '🍗 frango chicken leg',
    '🍔 hamburguer burger', '🍟 batata frita fries', '🍕 pizza', '🌭 cachorro quente hot dog', '🥪 sanduiche sandwich', '🌮 taco', '🌯 burrito',
    '🥗 salada salad', '🍝 macarrao spaghetti pasta', '🍜 lamen ramen', '🍣 sushi', '🍱 bento', '🍤 camarao shrimp', '🍙 onigiri arroz rice',
    '🍚 arroz rice', '🍦 sorvete ice cream', '🍨 sorvete ice cream', '🍩 rosquinha donut', '🍪 biscoito cookie', '🎂 bolo aniversario birthday cake',
    '🍰 bolo fatia cake', '🧁 cupcake', '🍫 chocolate', '🍬 bala candy', '🍭 pirulito lollipop', '🍯 mel honey', '☕ cafe coffee', '🍵 cha tea',
    '🧋 bubble tea', '🥤 refrigerante copo soda', '🧃 suco juice', '🍺 cerveja beer', '🍻 brinde cervejas cheers beers', '🥂 brinde champanhe cheers',
    '🍷 vinho wine', '🍸 drink coquetel cocktail', '🍹 drink tropical', '🍾 champanhe comemorar champagne', '🧉 chimarrao mate', '🥛 leite milk',
  ]),
  C('chatConv.emojiActivities', 'Atividades', [
    '⚽ futebol bola soccer football', '🏀 basquete basketball', '🏈 futebol americano football', '⚾ beisebol baseball', '🎾 tenis tennis',
    '🏐 volei volleyball', '🏓 ping pong', '🏸 badminton', '🥊 boxe boxing', '🥋 artes marciais martial arts', '⛳ golfe golf', '🎣 pesca fishing',
    '🏊 natacao swimming', '🚴 bicicleta ciclismo cycling', '🏋️ academia musculacao gym', '🤸 ginastica cartwheel', '🛹 skate', '🏄 surfe surf',
    '🎿 esqui ski', '🏆 trofeu campeao trophy winner', '🥇 ouro primeiro gold first', '🥈 prata segundo silver', '🥉 bronze terceiro bronze',
    '🏅 medalha medal', '🎖️ medalha militar medal', '🎮 videogame jogo game', '🕹️ joystick', '🎲 dado dice', '♟️ xadrez chess', '🎯 alvo na mosca target bullseye',
    '🎳 boliche bowling', '🎰 caca niquel slot', '🧩 quebra cabeca puzzle', '🎨 arte pintura art', '🎭 teatro theater', '🎬 cinema filme movie',
    '🎤 microfone karaoke mic', '🎧 fone musica headphones', '🎼 partitura music', '🎵 nota musical music', '🎶 musica music notes', '🎹 piano teclado',
    '🥁 bateria drum', '🎷 saxofone sax', '🎺 trompete trumpet', '🎸 guitarra violao guitar', '🎻 violino violin', '🎉 festa comemorar party tada',
    '🎊 confete confetti', '🎈 balao balloon', '🎁 presente gift', '🎀 laco ribbon', '🎄 natal arvore christmas', '🎆 fogos fireworks', '🎇 fogos sparkler',
    '🪅 pinata', '🎟️ ingresso ticket', '🎫 bilhete ticket',
  ]),
  C('chatConv.emojiTravel', 'Viagens e lugares', [
    '🚗 carro car', '🚕 taxi', '🚙 suv carro', '🚌 onibus bus', '🏎️ corrida carro race car', '🚓 policia police', '🚑 ambulancia ambulance',
    '🚒 bombeiros fire engine', '🚚 caminhao truck', '🏍️ moto motorcycle', '🛵 moto scooter', '🚲 bicicleta bike', '🛴 patinete scooter',
    '🚂 trem train', '🚇 metro subway', '✈️ aviao viagem airplane travel', '🛫 decolando departure', '🛬 pousando arrival', '🚀 foguete rocket',
    '🛸 disco voador ufo', '🚁 helicoptero helicopter', '⛵ veleiro sailboat', '🚢 navio ship', '⚓ ancora anchor', '🗺️ mapa map', '🧭 bussola compass',
    '🏖️ praia beach', '🏝️ ilha island', '⛰️ montanha mountain', '🏔️ montanha neve mountain', '🌋 vulcao volcano', '🏕️ acampamento camping',
    '🏠 casa house home', '🏡 casa jardim home', '🏢 escritorio predio office', '🏥 hospital', '🏫 escola school', '🏨 hotel', '🏪 loja store',
    '⛪ igreja church', '🕌 mesquita mosque', '🗽 estatua liberdade liberty', '🗼 torre tower', '🏰 castelo castle', '🎡 roda gigante ferris wheel',
    '🎢 montanha russa roller coaster', '⛲ fonte fountain', '🌃 noite cidade night city', '🌅 nascer do sol sunrise', '🌄 por do sol sunset mountains',
    '🌉 ponte bridge', '🧳 mala bagagem luggage', '⛽ posto gasolina fuel', '🚦 semaforo traffic light', '🚧 obra construction',
  ]),
  C('chatConv.emojiObjects', 'Objetos', [
    '📱 celular phone mobile', '💻 notebook laptop computer', '⌨️ teclado keyboard', '🖥️ computador desktop', '🖨️ impressora printer', '📷 camera foto',
    '📸 foto flash camera', '📹 filmadora video camera', '🎥 camera cinema movie', '📺 tv televisao', '📻 radio', '⏰ despertador alarm clock',
    '⌛ ampulheta hourglass', '⏳ tempo hourglass', '💡 ideia lampada idea bulb', '🔦 lanterna flashlight', '🕯️ vela candle', '💸 dinheiro voando money',
    '💵 dinheiro dolar money', '💰 saco de dinheiro money bag', '💳 cartao credit card', '💎 diamante gem diamond', '🔧 chave ferramenta wrench',
    '🔨 martelo hammer', '⚙️ engrenagem gear', '🔑 chave key', '🔒 cadeado trancado lock', '🔓 cadeado aberto unlock', '🛡️ escudo shield',
    '💊 remedio pilula pill', '💉 vacina injecao syringe', '🩺 estetoscopio stethoscope', '🧸 ursinho teddy bear', '🛒 carrinho compras cart',
    '🎒 mochila backpack', '👓 oculos glasses', '🕶️ oculos escuros sunglasses', '👔 camisa gravata shirt', '👕 camiseta tshirt', '👗 vestido dress',
    '👟 tenis sneaker', '👠 salto high heel', '💄 batom lipstick', '💍 anel alianca ring', '☂️ guarda chuva umbrella', '📚 livros books', '📖 livro book',
    '📝 anotacao memo note', '✏️ lapis pencil', '🖊️ caneta pen', '📌 alfinete pin', '📎 clipe clip', '✂️ tesoura scissors', '📦 caixa pacote package box',
    '✉️ envelope email', '📧 email', '📅 calendario calendar', '📊 grafico chart', '📈 subindo crescimento chart up', '📉 caindo chart down',
    '🗑️ lixo lixeira trash', '🔔 sino notificacao bell', '📣 megafone anuncio megaphone', '🔍 lupa buscar search', '🧯 extintor', '🪄 varinha magica magic wand',
  ]),
  C('chatConv.emojiSymbols', 'Símbolos', [
    '✅ certo feito check done', '☑️ marcado check', '✔️ certo check', '❌ errado x cross wrong', '❎ x cross', '⭕ circulo circle', '🚫 proibido prohibited',
    '⛔ proibido no entry', '❗ exclamacao exclamation', '❓ pergunta question', '‼️ exclamacao dupla', '⁉️ interrogacao exclamacao', '💯 cem perfeito hundred',
    '🔝 top', '🆗 ok', '🆒 cool', '🆕 novo new', '🆓 gratis free', '🔞 maior de 18', '⚠️ atencao aviso warning', '🔄 repetir refresh', '➕ mais plus',
    '➖ menos minus', '✖️ vezes multiply', '➗ dividir divide', '♾️ infinito infinity', '💲 cifrao dollar', '©️ copyright', '®️ registered', '™️ marca trademark',
    '🔴 vermelho red circle', '🟠 laranja orange circle', '🟡 amarelo yellow circle', '🟢 verde green circle', '🔵 azul blue circle', '🟣 roxo purple circle',
    '⚫ preto black circle', '⚪ branco white circle', '🟥 quadrado vermelho', '🟩 quadrado verde', '🟦 quadrado azul', '⬛ quadrado preto', '⬜ quadrado branco',
    '💤 sono zzz sleep', '💢 raiva anger', '💥 explosao boom', '💫 tonto estrela dizzy', '💬 balao fala chat speech', '💭 pensamento thought',
    '🗯️ balao raiva', '♻️ reciclar recycle', '☮️ paz peace', '☯️ yin yang', '✝️ cruz cross', '☪️ lua estrela', '🕉️ om', '✡️ estrela davi',
    '♈ aries', '♉ touro taurus', '♊ gemeos gemini', '♋ cancer', '♌ leao leo', '♍ virgem virgo', '♎ libra', '♏ escorpiao scorpio', '♐ sagitario',
    '♑ capricornio', '♒ aquario', '♓ peixes pisces', '🔔 sino bell', '🎵 musica music', '⏩ avancar fast forward', '⏪ voltar rewind', '▶️ play',
    '⏸️ pausa pause', '🔇 mudo mute', '🔊 som alto loud', '📢 alto falante loudspeaker',
  ]),
  C('chatConv.emojiFlags', 'Bandeiras', [
    '🇧🇷 brasil brazil', '🇵🇹 portugal', '🇺🇸 estados unidos eua usa', '🇬🇧 reino unido inglaterra uk', '🇪🇸 espanha spain', '🇫🇷 franca france',
    '🇩🇪 alemanha germany', '🇮🇹 italia italy', '🇯🇵 japao japan', '🇨🇳 china', '🇰🇷 coreia korea', '🇮🇳 india', '🇦🇷 argentina', '🇲🇽 mexico',
    '🇨🇦 canada', '🇨🇱 chile', '🇨🇴 colombia', '🇺🇾 uruguai uruguay', '🇵🇾 paraguai paraguay', '🇵🇪 peru', '🇧🇴 bolivia', '🇻🇪 venezuela',
    '🇦🇴 angola', '🇲🇿 mocambique mozambique', '🇨🇻 cabo verde', '🇳🇱 holanda netherlands', '🇧🇪 belgica belgium', '🇨🇭 suica switzerland',
    '🇷🇺 russia', '🇺🇦 ucrania ukraine', '🇹🇷 turquia turkey', '🇮🇱 israel', '🇸🇦 arabia saudita saudi', '🇦🇺 australia', '🇿🇦 africa do sul south africa',
    '🇳🇬 nigeria', '🇪🇬 egito egypt', '🏳️‍🌈 arco iris orgulho pride rainbow', '🏴‍☠️ pirata pirate', '🏁 quadriculada chegada checkered', '🚩 bandeira vermelha red flag',
    '🏳️ bandeira branca white flag', '🇪🇺 uniao europeia eu',
  ]),
];

let _payload = null;
let _payloadKey = '';

/** Payload compacto p/ o nativo: { cats: [{ t, e: [emoji], k: [palavras] }] }. */
export function nativeEmojiPayload(t) {
  const tf = (k, fb) => {
    try { const v = t ? t(k) : ''; return v && v !== k ? v : fb; } catch { return fb; }
  };
  const titles = EMOJI_CATS.map(c => tf(c.tk, c.fb));
  const key = titles.join('|');
  if (_payload && _payloadKey === key) return _payload;
  const cats = EMOJI_CATS.map((c, i) => {
    const e = [];
    const k = [];
    for (const s of c.list) {
      const sp = s.indexOf(' ');
      const em = sp > 0 ? s.slice(0, sp) : s;
      e.push(em);
      k.push(sp > 0 ? s.slice(sp + 1) : '');
    }
    return { t: titles[i], e, k };
  });
  _payload = { cats };
  _payloadKey = key;
  return _payload;
}
