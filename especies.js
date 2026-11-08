// Base de datos ecológica de especies (orientativa, enfocada a la Península Ibérica).
// hab: afinidad 0..1 por tipo de hábitat detectado en OpenStreetMap
//   conifer = pinar/abetal, broad = frondosas, mixed = bosque mixto, forest = bosque sin tipo,
//   scrub = matorral/jaral/brezal, open = prado/pastizal, euca = eucaliptal
// alt: altitud óptima (m). ph: pH del suelo óptimo. temp: media diaria del aire óptima los últimos 7 días (°C)
// soilT: temperatura del suelo óptima (°C), si la especie depende mucho de ella
// rain30: lluvia acumulada deseable en 30 días (mm). trigger: tormenta "disparadora" (mm en 3 días)
// lag: días que suelen pasar entre la lluvia fuerte y la fructificación [mín, máx]
window.ESPECIES = [
  // ---------- OTOÑO ----------
  {
    id: "niscalo", parecidas: [{"latin": "Lactarius torminosus", "nivel": "tóxica"}], borde: true, name: "Níscalo", latin: "Lactarius deliciosus", grupo: "otono",
    months: [10, 11, 12], hosts: ["Pinus"],
    hab: { conifer: 1, mixed: 0.6, forest: 0.45, broad: 0.05, scrub: 0.1, open: 0.05, euca: 0 },
    alt: [200, 1500], ph: [5.0, 8.0], temp: [8, 15], rain30: 60, trigger: 25, lag: [8, 20],
    nota: "Pinares jóvenes y repoblaciones (P. pinaster, P. sylvestris, P. nigra, P. halepensis). Taludes con musgo y pinocha. Tolera suelos calizos.",
    aviso: "No confundir con Lactarius torminosus (tóxico, borde peludo, látex blanco). El níscalo suelta látex naranja que verdea."
  },
  {
    id: "boletus-edulis", parecidas: [{"latin": "Tylopilus felleus", "nivel": "no comestible (amarga)"}, {"latin": "Rubroboletus satanas", "nivel": "tóxica"}], name: "Boleto / Hongo calabaza", latin: "Boletus edulis", grupo: "otono",
    months: [9, 10, 11], hosts: ["Fagus", "Pinus", "Quercus", "Castanea", "Betula", "Abies"],
    hab: { conifer: 0.8, broad: 0.9, mixed: 1, forest: 0.7, scrub: 0.15, open: 0.05, euca: 0.02 },
    alt: [600, 1800], ph: [4.5, 6.5], temp: [10, 17], rain30: 70, trigger: 25, lag: [8, 18],
    nota: "Hayedos, robledales, castañares y pinares de silvestre en suelos ácidos. Muy ligado a una tormenta fuerte con suelo aún templado.",
    aviso: "Ojo con Tylopilus felleus (amargo, retículo oscuro) y Rubroboletus satanas (tóxico, poros rojos)."
  },
  {
    id: "boletus-aereus", parecidas: [{"latin": "Rubroboletus satanas", "nivel": "tóxica"}], name: "Boleto negro", latin: "Boletus aereus", grupo: "otono",
    months: [9, 10, 11], hosts: ["Quercus", "Castanea"],
    hab: { broad: 1, mixed: 0.7, forest: 0.6, conifer: 0.1, scrub: 0.3, open: 0.1, euca: 0 },
    alt: [200, 1200], ph: [4.5, 6.5], temp: [13, 20], rain30: 60, trigger: 25, lag: [8, 18],
    nota: "Termófilo: encinares, alcornocales, rebollares y castañares soleados sobre suelo ácido.",
    aviso: "Comprobar siempre que los poros sean blancos o amarillentos y la carne no azulee con fuerza."
  },
  {
    id: "rebozuelo", parecidas: [{"latin": "Omphalotus olearius", "nivel": "tóxica"}, {"latin": "Hygrophoropsis aurantiaca", "nivel": "no comestible"}], borde: true, name: "Rebozuelo", latin: "Cantharellus cibarius", grupo: "otono",
    months: [6, 7, 9, 10, 11], hosts: ["Quercus", "Fagus", "Castanea", "Pinus", "Betula"],
    hab: { broad: 1, mixed: 0.9, conifer: 0.7, forest: 0.65, scrub: 0.25, open: 0.05, euca: 0.05 },
    alt: [300, 1500], ph: [4.0, 6.0], temp: [12, 19], rain30: 55, trigger: 20, lag: [7, 16],
    nota: "Taludes musgosos y claros de robledal, hayedo o castañar en suelos ácidos. Fructifica en tandas tras lluvias templadas.",
    aviso: "No confundir con Omphalotus olearius (tóxico, en matas sobre madera) ni Hygrophoropsis aurantiaca (láminas verdaderas)."
  },
  {
    id: "oronja", parecidas: [{"latin": "Amanita muscaria", "nivel": "tóxica"}, {"latin": "Amanita phalloides", "nivel": "mortal"}], name: "Oronja / Amanita de los Césares", latin: "Amanita caesarea", grupo: "otono",
    months: [7, 8, 9, 10], hosts: ["Quercus", "Castanea"],
    hab: { broad: 1, mixed: 0.6, forest: 0.55, conifer: 0.1, scrub: 0.35, open: 0.1, euca: 0 },
    alt: [200, 1100], ph: [4.5, 6.5], temp: [16, 24], rain30: 50, trigger: 25, lag: [6, 14],
    nota: "Castañares, alcornocales y rebollares cálidos tras tormentas de final de verano.",
    aviso: "PELIGRO: no recolectar en estado de huevo. Confundible con Amanita muscaria y, de joven, con amanitas mortales. Láminas y pie siempre amarillos."
  },
  {
    id: "parasol", parecidas: [{"latin": "Chlorophyllum brunneum", "nivel": "tóxica"}, {"latin": "Lepiota brunneoincarnata", "nivel": "mortal"}], borde: true, name: "Parasol / Galamperna", latin: "Macrolepiota procera", grupo: "otono",
    months: [8, 9, 10, 11], hosts: [],
    hab: { open: 1, scrub: 0.8, broad: 0.55, mixed: 0.5, conifer: 0.45, forest: 0.5, euca: 0.2 },
    alt: [0, 1500], ph: [5.0, 7.5], temp: [12, 20], rain30: 45, trigger: 20, lag: [5, 12],
    nota: "Saprófita: claros, bordes de bosque, prados y caminos. Responde rápido a la lluvia.",
    aviso: "Solo ejemplares grandes (sombrero > 10 cm) con anillo móvil. Las lepiotas pequeñas pueden ser mortales; ojo con Chlorophyllum."
  },
  {
    id: "trompeta", parecidas: [], name: "Trompeta de los muertos", latin: "Craterellus cornucopioides", grupo: "otono",
    months: [9, 10, 11], hosts: ["Fagus", "Quercus", "Castanea"],
    hab: { broad: 1, mixed: 0.7, forest: 0.6, conifer: 0.2, scrub: 0.1, open: 0, euca: 0 },
    alt: [400, 1500], ph: [5.0, 7.5], temp: [10, 16], rain30: 70, trigger: 20, lag: [8, 18],
    nota: "Hayedos y robledales umbríos, en hojarasca húmeda; sale en grupos numerosos.",
    aviso: "Fácil de reconocer, pero se camufla en la hojarasca. Recolectar limpia para no llevar tierra."
  },
  {
    id: "capuchina", parecidas: [{"latin": "Tricholoma pardinum", "nivel": "tóxica"}, {"latin": "Tricholoma equestre", "nivel": "tóxica"}], name: "Negrilla / Capuchina", latin: "Tricholoma portentosum", grupo: "otono",
    months: [10, 11, 12], hosts: ["Pinus"],
    hab: { conifer: 1, mixed: 0.6, forest: 0.45, broad: 0.15, scrub: 0.05, open: 0, euca: 0 },
    alt: [500, 1600], ph: [4.5, 6.5], temp: [4, 12], rain30: 50, trigger: 20, lag: [10, 25],
    nota: "Pinares de silvestre y laricio, muy tardía: aguanta las primeras heladas.",
    aviso: "No confundir con Tricholoma pardinum (tóxico) ni T. equestre (desaconsejado)."
  },
  {
    id: "seta-cardo", parecidas: [], name: "Seta de cardo", latin: "Pleurotus eryngii", grupo: "otono",
    months: [10, 11, 12, 3, 4], hosts: [],
    hab: { open: 1, scrub: 0.6, forest: 0.1, broad: 0.1, mixed: 0.1, conifer: 0.05, euca: 0 },
    alt: [200, 1400], ph: [6.5, 8.5], temp: [8, 16], rain30: 45, trigger: 20, lag: [5, 14],
    nota: "Pastizales, eriales y barbechos con cardo corredor (Eryngium campestre), sobre suelo calizo.",
    aviso: "Buscar siempre unida a la raíz del cardo corredor."
  },
  {
    id: "lengua-vaca", parecidas: [], name: "Lengua de vaca", latin: "Hydnum repandum", grupo: "otono",
    months: [9, 10, 11, 12], hosts: ["Fagus", "Quercus", "Pinus", "Castanea"],
    hab: { broad: 1, mixed: 0.95, conifer: 0.75, forest: 0.7, scrub: 0.2, open: 0, euca: 0 },
    alt: [300, 1600], ph: [4.5, 7.0], temp: [8, 15], rain30: 60, trigger: 20, lag: [8, 20],
    nota: "Bosques frescos con musgo; suele salir en corros. Púas en lugar de láminas.",
    aviso: "Los ejemplares viejos amargan; mejor jóvenes."
  },
  {
    id: "angula-monte", parecidas: [{"latin": "Hygrophoropsis aurantiaca", "nivel": "no comestible"}], name: "Angula de monte / Trompeta amarilla", latin: "Craterellus lutescens", grupo: "otono",
    months: [10, 11, 12, 1], hosts: ["Pinus", "Quercus", "Fagus", "Abies"],
    hab: { conifer: 1, mixed: 0.95, broad: 0.75, forest: 0.7, scrub: 0.2, open: 0, euca: 0 },
    alt: [300, 1500], ph: [6.0, 8.0], temp: [6, 14], rain30: 70, trigger: 20, lag: [8, 20],
    nota: "En grupos numerosos sobre musgo muy húmedo: pinares y bosques mixtos junto a arroyos, fuentes y zonas encharcadas, a menudo en suelos calizos o neutros. Tardía.",
    aviso: "Sombrero pardo y pie amarillo-anaranjado hueco. Parecida a Craterellus tubaeformis (también comestible, pie más grisáceo). No confundir con Hygrophoropsis aurantiaca ni con pequeños Cortinarius anaranjados."
  },
  {
    id: "llanega", parecidas: [{"latin": "Cortinarius collinitus", "nivel": "no comestible"}], name: "Llanega negra", latin: "Hygrophorus latitabundus", grupo: "otono",
    months: [11, 12, 1], hosts: ["Pinus"],
    hab: { conifer: 1, mixed: 0.6, forest: 0.45, broad: 0.05, scrub: 0.15, open: 0, euca: 0 },
    alt: [200, 1400], ph: [6.5, 8.5], temp: [4, 12], rain30: 50, trigger: 20, lag: [10, 25], frostTol: true,
    nota: "Pinares calizos (pino carrasco, laricio, rodeno) en pleno invierno; sale semienterrada bajo la pinocha y aguanta el frío.",
    aviso: "Sombrero muy viscoso pardo oscuro, láminas blancas y pie con anillo viscoso. No confundir con Cortinarius de sombrero viscoso (láminas que se vuelven color óxido), algunos tóxicos."
  },
  // ---------- PRIMAVERA ----------
  {
    id: "colmenilla", parecidas: [{"latin": "Gyromitra esculenta", "nivel": "mortal"}], name: "Colmenilla / Morilla", latin: "Morchella esculenta", grupo: "primavera",
    months: [3, 4, 5], hosts: ["Fraxinus", "Populus", "Ulmus", "Pinus", "Malus"],
    hab: { broad: 0.8, open: 0.7, mixed: 0.7, forest: 0.6, scrub: 0.5, conifer: 0.5, euca: 0.1 },
    alt: [0, 1500], ph: [6.5, 8.0], temp: [8, 15], soilT: [8, 14], rain30: 40, trigger: 15, lag: [5, 15],
    nota: "Riberas con fresnos y chopos, huertos viejos, zonas quemadas el año anterior, suelos calizos. Responde al calentamiento del suelo tras lluvia.",
    aviso: "PELIGRO: confundible con Gyromitra esculenta (mortal, sombrero cerebriforme). Hueca por dentro y siempre bien cocinada; cruda es tóxica."
  },
  {
    id: "perrechico", parecidas: [{"latin": "Inocybe erubescens", "nivel": "mortal"}, {"latin": "Entoloma sinuatum", "nivel": "tóxica"}], borde: true, name: "Perrechico / Seta de San Jorge", latin: "Calocybe gambosa", grupo: "primavera",
    months: [4, 5, 6], hosts: ["Crataegus", "Prunus", "Rosa"],
    hab: { open: 1, scrub: 0.85, broad: 0.4, mixed: 0.3, forest: 0.3, conifer: 0.15, euca: 0 },
    alt: [600, 1600], ph: [6.5, 8.5], temp: [9, 16], soilT: [8, 14], rain30: 45, trigger: 15, lag: [6, 15],
    nota: "Corros en prados de montaña, junto a espinos y endrinos, sobre suelos calizos. Olor fuerte a harina.",
    aviso: "PELIGRO: confundible con Inocybe erubescens (mortal, enrojece) y Entoloma sinuatum (tóxico, láminas rosadas)."
  },
  {
    id: "marzuelo", parecidas: [], name: "Marzuelo", latin: "Hygrophorus marzuolus", grupo: "primavera",
    months: [2, 3, 4, 5], hosts: ["Pinus", "Abies", "Fagus"],
    hab: { conifer: 1, mixed: 0.9, broad: 0.55, forest: 0.6, scrub: 0.05, open: 0, euca: 0 },
    alt: [900, 1900], ph: [4.5, 6.0], temp: [1, 9], soilT: [2, 8], rain30: 40, trigger: 15, lag: [5, 20], frostTol: true, deshielo: true,
    nota: "Sale semienterrado bajo la pinocha justo tras el deshielo, en pinares de silvestre y abetales ácidos.",
    aviso: "Busca bultos en la pinocha: rara vez asoma entero."
  },
  {
    id: "champinon", parecidas: [{"latin": "Amanita verna", "nivel": "mortal"}, {"latin": "Amanita phalloides", "nivel": "mortal"}, {"latin": "Agaricus xanthodermus", "nivel": "tóxica"}], name: "Champiñón silvestre", latin: "Agaricus campestris", grupo: "primavera",
    months: [4, 5, 6, 9, 10, 11], hosts: [],
    hab: { open: 1, scrub: 0.4, broad: 0.1, mixed: 0.1, forest: 0.05, conifer: 0.05, euca: 0 },
    alt: [0, 1500], ph: [6.0, 8.0], temp: [12, 20], rain30: 40, trigger: 15, lag: [4, 10],
    nota: "Prados abonados por ganado, pastizales y dehesas tras lluvias templadas.",
    aviso: "PELIGRO: las amanitas blancas (A. verna, A. virosa, A. phalloides) son mortales. Las láminas del champiñón nunca son blancas en el adulto, no hay volva. Evitar A. xanthodermus (amarillea, olor a tinta)."
  },
  {
    id: "boleto-verano", parecidas: [{"latin": "Rubroboletus satanas", "nivel": "tóxica"}], name: "Boleto de verano", latin: "Boletus reticulatus", grupo: "primavera",
    months: [5, 6, 7, 9], hosts: ["Quercus", "Fagus", "Castanea"],
    hab: { broad: 1, mixed: 0.7, forest: 0.6, conifer: 0.15, scrub: 0.2, open: 0.05, euca: 0 },
    alt: [300, 1400], ph: [4.5, 6.5], temp: [15, 22], rain30: 55, trigger: 25, lag: [7, 15],
    nota: "Robledales, hayedos y castañares tras tormentas cálidas de final de primavera.",
    aviso: "Mismas precauciones que con otros boletos: poros nunca rojos."
  },
  {
    id: "gurumelo", parecidas: [{"latin": "Amanita verna", "nivel": "mortal"}, {"latin": "Amanita phalloides", "nivel": "mortal"}], name: "Gurumelo", latin: "Amanita ponderosa", grupo: "primavera",
    months: [2, 3, 4, 5], hosts: ["Cistus", "Quercus"],
    hab: { scrub: 1, broad: 0.75, mixed: 0.5, forest: 0.45, open: 0.25, conifer: 0.1, euca: 0.05 },
    alt: [0, 800], ph: [4.5, 6.0], temp: [11, 18], rain30: 50, trigger: 20, lag: [7, 18], arena: true,
    nota: "Suroeste peninsular (Huelva, Badajoz, Alentejo): jarales y encinares sobre suelos arenosos ácidos. Sale casi enterrado.",
    aviso: "PELIGRO: es una amanita. Confundible con Amanita verna (mortal). Solo para recolectores expertos."
  }
];
