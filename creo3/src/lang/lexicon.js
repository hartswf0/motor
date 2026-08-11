// MULTILINGUAL BY ARCHITECTURE (§24).
//
// The lexicon maps surface forms in several languages onto canonical tokens.
// It never rewrites the utterance: the original expression is stored verbatim
// on the observation and on the transaction, and translation is a separate,
// non-destructive layer. Spatial intelligence must not be mistaken for English.

export const LANGS = ['en', 'sw', 'es', 'pt', 'fr'];

/** canonical token -> { lang: [surface forms] } */
const TERMS = {
  // --- deictic ---------------------------------------------------------------
  'DEIXIS.this':   { en: ['this', 'that', 'it'], sw: ['hii', 'hiyo', 'ile'], es: ['esto', 'esta', 'este', 'eso'], pt: ['isto', 'isso', 'este'], fr: ['ceci', 'cela', 'ça'] },
  'DEIXIS.these':  { en: ['these', 'those', 'them', 'both'], sw: ['hizi', 'hizo', 'zile'], es: ['estos', 'estas', 'esos', 'ambos'], pt: ['estes', 'esses', 'ambos'], fr: ['ces', 'ceux'] },
  'DEIXIS.here':   { en: ['here'], sw: ['hapa'], es: ['aqui', 'aquí', 'acá'], pt: ['aqui', 'cá'], fr: ['ici'] },
  'DEIXIS.there':  { en: ['there'], sw: ['pale', 'huko'], es: ['alli', 'allí', 'ahi', 'ahí'], pt: ['ali', 'lá'], fr: ['là'] },
  'DEIXIS.behind': { en: ['behind'], sw: ['nyuma', 'nyuma ya'], es: ['detras', 'detrás'], pt: ['atras', 'atrás'], fr: ['derriere', 'derrière'] },
  'DEIXIS.front':  { en: ['in front of', 'front of'], sw: ['mbele', 'mbele ya'], es: ['delante', 'frente'], pt: ['frente'], fr: ['devant'] },
  'DEIXIS.between':{ en: ['between'], sw: ['kati', 'kati ya'], es: ['entre'], pt: ['entre'], fr: ['entre'] },
  'DEIXIS.along':  { en: ['along'], sw: ['kando', 'kando ya'], es: ['a lo largo'], pt: ['ao longo'], fr: ['le long'] },
  'DEIXIS.around': { en: ['around'], sw: ['kuzunguka'], es: ['alrededor'], pt: ['ao redor'], fr: ['autour'] },
  'DEIXIS.toward': { en: ['toward', 'towards'], sw: ['kuelekea'], es: ['hacia'], pt: ['em direcao', 'em direção'], fr: ['vers'] },
  'DEIXIS.far':    { en: ['far', 'farthest', 'furthest'], sw: ['mbali'], es: ['lejano', 'lejos'], pt: ['distante'], fr: ['loin'] },
  'DEIXIS.next':   { en: ['next to', 'beside', 'adjacent'], sw: ['karibu na', 'jirani'], es: ['al lado', 'junto'], pt: ['ao lado'], fr: ['a cote', 'à côté'] },
  'DEIXIS.before': { en: ['where we were before', 'before'], sw: ['tulipokuwa'], es: ['donde estabamos', 'donde estábamos'], pt: ['onde estavamos'], fr: ['ou nous etions'] },
  'DEIXIS.corner': { en: ['corner'], sw: ['kona'], es: ['esquina'], pt: ['canto'], fr: ['coin'] },

  // --- verbs / operations ----------------------------------------------------
  'OP.observe':  { en: ['floods', 'flood', 'floods here', 'is flooded', 'collects', 'gathers', 'happens', 'always', 'gets', 'smells', 'is dark', 'unsafe', 'noisy', 'dusty', 'fills with', 'fills up', 'stands here', 'never dries'], sw: ['inafurika', 'mafuriko', 'giza', 'hatari', 'inajaa'], es: ['inunda', 'inunda aqui', 'se inunda', 'se llena', 'oscuro', 'peligroso'], pt: ['alaga', 'inunda', 'enche', 'escuro'], fr: ['inonde', 'se remplit', 'sombre'] },
  'OP.walk':     { en: ['walk', 'walks', 'walk here', 'pass', 'go through', 'shortcut'], sw: ['tembea', 'wanapita'], es: ['caminan', 'pasan', 'atajo'], pt: ['caminham', 'passam', 'atalho'], fr: ['marchent', 'passent'] },
  'OP.propose':  { en: ['should be', 'should have', 'put', 'add', 'build', 'plant', 'make a', 'we need', 'need a', 'want a', 'lets', "let's", 'create'], sw: ['tuweke', 'panda', 'jenga', 'tunahitaji', 'weka'], es: ['deberia', 'debería', 'poner', 'construir', 'plantar', 'necesitamos', 'agregar'], pt: ['deveria', 'colocar', 'construir', 'plantar', 'precisamos'], fr: ['devrait', 'mettre', 'construire', 'planter'] },
  // Comparatives live in the Q.* families only. Listing "taller" here as well
  // meant the tagger's first match masked the other, so "make this 3 m taller"
  // lost its axis and applied the number to width.
  'OP.modify':   { en: ['make this', 'make it', 'raise', 'lower', 'widen', 'narrow', 'extend', 'move', 'rotate', 'set'], sw: ['ongeza', 'punguza', 'panua', 'sogeza'], es: ['hacer', 'subir', 'bajar', 'ampliar', 'mover'], pt: ['aumentar', 'baixar', 'alargar', 'mover'], fr: ['augmenter', 'elargir', 'deplacer'] },
  'OP.relate':   { en: ['connect', 'join together', 'join'], sw: ['unganisha'], es: ['conectar', 'unir'], pt: ['conectar', 'unir'], fr: ['relier', 'connecter'] },
  'OP.preserve': { en: ['keep', 'preserve', 'protect', 'save', 'dont touch', "don't touch", 'leave'], sw: ['acha', 'hifadhi', 'linda'], es: ['mantener', 'conservar', 'proteger', 'dejar'], pt: ['manter', 'preservar', 'deixar'], fr: ['garder', 'preserver', 'laisser'] },
  'OP.remove':   { en: ['remove', 'delete', 'take out', 'demolish', 'clear out', 'no more'], sw: ['ondoa', 'bomoa'], es: ['quitar', 'eliminar', 'demoler'], pt: ['remover', 'demolir'], fr: ['enlever', 'supprimer'] },
  'OP.branch':   { en: ['show', 'what if', 'imagine', 'as if', 'version', 'option', 'alternative', 'futures', 'future'], sw: ['onyesha', 'kama', 'chaguo'], es: ['mostrar', 'que pasa si', 'imagina', 'opcion', 'opción'], pt: ['mostrar', 'e se', 'imagine', 'opcao'], fr: ['montre', 'et si', 'imagine', 'option'] },
  // Weather and time-of-day belong to Q.rain / Q.night; duplicating them here
  // swallowed the very phrases that trigger the simulation.
  'OP.simulate': { en: ['what happens', 'simulate', 'test it', 'years pass', 'years', 'grow'], sw: ['miaka'], es: ['anos', 'años', 'simular'], pt: ['anos', 'simular'], fr: ['ans', 'simuler'] },
  'OP.ask':      { en: ['what', 'why', 'who', 'where', 'which', 'how many', 'how much', 'compare', 'can', 'is there'], sw: ['nini', 'kwanini', 'nani', 'wapi', 'ngapi'], es: ['que', 'qué', 'por que', 'quien', 'quién', 'donde', 'dónde', 'cuanto', 'comparar'], pt: ['que', 'porque', 'quem', 'onde', 'quantos'], fr: ['quoi', 'pourquoi', 'qui', 'ou', 'où', 'combien'] },
  'OP.measure':  { en: ['how long', 'how wide', 'how far', 'measure', 'area of', 'distance'], sw: ['umbali', 'pima'], es: ['distancia', 'medir', 'area'], pt: ['distancia', 'medir'], fr: ['distance', 'mesurer'] },

  // --- things ---------------------------------------------------------------
  'THING.tree':      { en: ['tree', 'trees', 'shade tree'], sw: ['mti', 'miti'], es: ['arbol', 'árbol', 'arboles', 'árboles'], pt: ['arvore', 'árvores'], fr: ['arbre', 'arbres'] },
  'THING.garden':    { en: ['garden', 'community garden', 'rain garden', 'planting'], sw: ['bustani', 'shamba'], es: ['jardin', 'jardín', 'huerto'], pt: ['jardim', 'horta'], fr: ['jardin'] },
  'THING.drain':     { en: ['drain', 'ditch', 'channel', 'culvert', 'gutter'], sw: ['mtaro', 'mfereji'], es: ['drenaje', 'canal', 'zanja'], pt: ['dreno', 'canal', 'vala'], fr: ['drain', 'canal', 'fosse'] },
  'THING.swale':     { en: ['swale', 'bioswale', 'soakaway'], sw: ['mtaro wa maji'], es: ['cuneta verde'], pt: ['vala verde'], fr: ['noue'] },
  'THING.path':      { en: ['path', 'walkway', 'footpath', 'sidewalk', 'pavement'], sw: ['njia', 'kijia'], es: ['sendero', 'acera', 'camino'], pt: ['caminho', 'calcada'], fr: ['chemin', 'trottoir'] },
  'THING.road':      { en: ['road', 'street', 'lane'], sw: ['barabara', 'mtaa'], es: ['calle', 'carretera'], pt: ['rua', 'estrada'], fr: ['rue', 'route'] },
  'THING.building':  { en: ['building', 'buildings', 'house', 'houses', 'structure', 'shed'], sw: ['jengo', 'majengo', 'nyumba'], es: ['edificio', 'casa', 'casas'], pt: ['edificio', 'casa'], fr: ['batiment', 'bâtiment', 'maison'] },
  'THING.room':      { en: ['room', 'rooms'], sw: ['chumba', 'vyumba'], es: ['cuarto', 'habitacion'], pt: ['quarto', 'sala'], fr: ['piece', 'pièce', 'salle'] },
  'THING.floor':     { en: ['floor', 'storey', 'story', 'level'], sw: ['ghorofa'], es: ['piso', 'planta'], pt: ['andar', 'piso'], fr: ['etage', 'étage'] },
  'THING.greenhouse':{ en: ['greenhouse', 'glasshouse'], sw: ['kitalu'], es: ['invernadero'], pt: ['estufa'], fr: ['serre'] },
  'THING.bridge':    { en: ['bridge', 'walkway', 'link'], sw: ['daraja'], es: ['puente'], pt: ['ponte'], fr: ['pont'] },
  'THING.bench':     { en: ['bench', 'seat', 'seating'], sw: ['benchi', 'kiti'], es: ['banco'], pt: ['banco'], fr: ['banc'] },
  'THING.light':     { en: ['light', 'lamp', 'streetlight', 'lighting'], sw: ['taa'], es: ['luz', 'farola'], pt: ['luz', 'poste'], fr: ['lampadaire', 'lumiere'] },
  'THING.water':     { en: ['water', 'pond', 'river', 'stream', 'channel'], sw: ['maji', 'mto'], es: ['agua', 'rio', 'río'], pt: ['agua', 'rio'], fr: ['eau', 'riviere'] },
  'THING.wall':      { en: ['wall', 'fence'], sw: ['ukuta', 'uzio'], es: ['muro', 'pared', 'valla'], pt: ['muro', 'parede'], fr: ['mur', 'cloture'] },
  'THING.car':       { en: ['car', 'cars', 'parking', 'traffic', 'vehicles'], sw: ['gari', 'magari'], es: ['coche', 'coches', 'autos', 'trafico'], pt: ['carro', 'carros'], fr: ['voiture', 'voitures'] },
  'THING.market':    { en: ['market', 'stall', 'stalls', 'kiosk', 'shop'], sw: ['soko', 'kibanda', 'duka'], es: ['mercado', 'puesto', 'tienda'], pt: ['mercado', 'banca'], fr: ['marche', 'marché', 'etal'] },
  'THING.roof':      { en: ['roof', 'rooftop'], sw: ['paa'], es: ['techo', 'azotea'], pt: ['telhado'], fr: ['toit'] },
  'THING.window':    { en: ['window', 'windows'], sw: ['dirisha', 'madirisha'], es: ['ventana', 'ventanas'], pt: ['janela'], fr: ['fenetre', 'fenêtre'] },
  'THING.people':    { en: ['people', 'children', 'kids', 'women', 'residents', 'everyone'], sw: ['watu', 'watoto', 'wanawake'], es: ['gente', 'ninos', 'niños', 'personas'], pt: ['pessoas', 'criancas'], fr: ['gens', 'enfants'] },

  // --- qualifiers -----------------------------------------------------------
  'Q.tall':    { en: ['tall', 'taller', 'high', 'higher'], sw: ['refu', 'juu'], es: ['alto', 'mas alto', 'más alto'], pt: ['alto'], fr: ['haut'] },
  'Q.wide':    { en: ['wide', 'wider', 'broad'], sw: ['pana'], es: ['ancho'], pt: ['largo'], fr: ['large'] },
  'Q.deep':    { en: ['deep', 'deeper'], sw: ['kina'], es: ['profundo'], pt: ['fundo'], fr: ['profond'] },
  'Q.long':    { en: ['long', 'longer'], sw: ['urefu'], es: ['largo'], pt: ['comprido'], fr: ['long'] },
  'Q.twice':   { en: ['twice', 'double'], sw: ['mara mbili'], es: ['doble'], pt: ['dobro'], fr: ['double'] },
  'Q.half':    { en: ['half'], sw: ['nusu'], es: ['mitad'], pt: ['metade'], fr: ['moitie'] },
  'Q.not':     { en: ['not', 'dont', "don't", 'without', 'except', 'but not', 'avoid'], sw: ['bila', 'usiweke', 'lakini si'], es: ['sin', 'no', 'excepto', 'evitar'], pt: ['sem', 'nao', 'exceto'], fr: ['sans', 'pas', 'sauf'] },
  'Q.block':   { en: ['block', 'blocks', 'blocking', 'cover', 'covering', 'obstruct'], sw: ['ziba', 'funga'], es: ['bloquear', 'tapar'], pt: ['bloquear', 'tapar'], fr: ['bloquer', 'couvrir'] },
  'Q.all':     { en: ['everything', 'all', 'every'], sw: ['yote', 'kila'], es: ['todo', 'todos'], pt: ['tudo', 'todos'], fr: ['tout', 'tous'] },
  'Q.night':   { en: ['night', 'at night', 'dark'], sw: ['usiku'], es: ['noche'], pt: ['noite'], fr: ['nuit'] },
  'Q.rain':    { en: ['rain', 'raining', 'heavy rain', 'storm', 'wet'], sw: ['mvua'], es: ['lluvia', 'tormenta'], pt: ['chuva'], fr: ['pluie'] },
  'Q.radical': { en: ['radically different', 'radical', 'different', 'very different'], sw: ['tofauti'], es: ['diferentes', 'radicalmente'], pt: ['diferentes'], fr: ['differents'] },
};

// Flat surface-form index, longest-first so multiword forms win.
const INDEX = [];
for (const [token, byLang] of Object.entries(TERMS)) {
  for (const [lang, forms] of Object.entries(byLang)) {
    for (const form of forms) INDEX.push({ form: form.toLowerCase(), token, lang, n: form.split(/\s+/).length });
  }
}
INDEX.sort((a, b) => b.form.length - a.form.length);

export function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/(\d)[.,](\d)/g, '$1·$2')   // protect decimals: 5.25 m must survive
    .replace(/[.,!?;:()"]/g, ' ')
    .replace(/·/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tag an utterance with canonical tokens. Returns the tokens found, the language
 * evidence, and — crucially — the untouched original.
 */
export function tag(text) {
  const original = text;
  const norm = normalize(text);
  const hits = [];
  const langVotes = new Map();
  let masked = ` ${norm} `;
  for (const entry of INDEX) {
    const needle = ` ${entry.form} `;
    let at = masked.indexOf(needle);
    // also match at word boundaries inside the masked string
    if (at === -1) {
      const re = new RegExp(`(?<=\\s)${escapeRe(entry.form)}(?=\\s)`);
      const m = masked.match(re);
      at = m ? m.index : -1;
    }
    if (at >= 0) {
      hits.push({ token: entry.token, form: entry.form, at, lang: entry.lang });
      langVotes.set(entry.lang, (langVotes.get(entry.lang) || 0) + entry.n);
      masked = masked.slice(0, at) + ' '.repeat(entry.form.length) + masked.slice(at + entry.form.length);
    }
  }
  hits.sort((a, b) => a.at - b.at);
  let lang = 'en', bestVotes = 0;
  for (const [l, v] of langVotes) if (v > bestVotes) { bestVotes = v; lang = l; }
  return { original, norm, tokens: hits, lang, has: (t) => hits.some((h) => h.token === t) };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A surface form claimed by two categories is a silent bug: the tagger masks the
 * text on first match, so whichever entry sorts first wins and the other token
 * never fires. Exported so the test suite can keep the lexicon honest.
 */
export function lexiconCollisions() {
  const byForm = new Map();
  for (const [token, byLang] of Object.entries(TERMS)) {
    for (const forms of Object.values(byLang)) {
      for (const form of forms) {
        const f = form.toLowerCase();
        if (!byForm.has(f)) byForm.set(f, new Set());
        byForm.get(f).add(token.split('.')[0]);
      }
    }
  }
  const out = [];
  for (const [form, families] of byForm) {
    // A form may name several things of the same kind; it may not straddle
    // an operation and a qualifier, or two different operations.
    if (families.size > 1) out.push({ form, families: [...families] });
  }
  return out;
}

// ------------------------------------------------------------- quantities ---
const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  twenty: 20, thirty: 30, fifty: 50, hundred: 100,
  moja: 1, mbili: 2, tatu: 3, nne: 4, tano: 5,
  uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, veinte: 20,
};

/** Pull real numbers with units out of an utterance. Precision is a first-class input. */
export function quantities(text) {
  const out = [];
  const norm = normalize(text);
  const re = /(-?\d+(?:\.\d+)?)\s*(m|metre|metres|meter|meters|cm|mm|km|ft|feet|%|percent|deg|degrees|°|m2|sqm|m²)?/g;
  let m;
  while ((m = re.exec(norm))) {
    const v = parseFloat(m[1]);
    const unit = (m[2] || '').replace('metres', 'm').replace('metre', 'm').replace('meters', 'm').replace('meter', 'm');
    let metres = v;
    if (unit === 'cm') metres = v / 100;
    else if (unit === 'mm') metres = v / 1000;
    else if (unit === 'km') metres = v * 1000;
    else if (unit === 'ft' || unit === 'feet') metres = v * 0.3048;
    out.push({ value: v, unit: unit || null, metres, at: m.index });
  }
  for (const [w, v] of Object.entries(WORD_NUMBERS)) {
    const i = ` ${norm} `.indexOf(` ${w} `);
    if (i >= 0) out.push({ value: v, unit: null, metres: v, at: i, word: w });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Which canonical THING is being talked about? */
export function thingOf(tagged) {
  const t = tagged.tokens.find((h) => h.token.startsWith('THING.'));
  return t ? t.token.slice(6) : null;
}
export function things(tagged) {
  return tagged.tokens.filter((h) => h.token.startsWith('THING.')).map((h) => h.token.slice(6));
}
