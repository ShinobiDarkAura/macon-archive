/* Maçon — draft letters, in one place.
 *
 * Both the archive and the weekly digest read from this file, so a wording fix
 * lands in both at once. Keeping two copies is what let the digest send "Hi
 * Thailand" and five byte-identical patron letters while the app said something
 * different again.
 *
 * Rules these follow, from the studio's own copy guidelines: no em dashes,
 * short ideas joined with commas rather than stacked, nothing pitchy, and each
 * letter ending on something answerable in a sentence.
 */

/* ---------- grammar ---------- */

// "Thailand bronzes enquiry" is a label, not a person.
export function firstName(n){
  const raw = String(n || "").trim();
  if (!raw || /enquiry|inquiry|unknown|test/i.test(raw)) return "there";
  const w = raw.split(/\s+/)[0].replace(/[^\p{L}'-]/gu, "");
  return w.length > 1 ? w : "there";
}

// Only article a phrase that is short and plainly singular: "a snail" is right,
// "a bronze pieces, possibly cutlery" is worse than nothing.
export function withArticle(t){
  const s = String(t || "").trim();
  if (!s) return "something";
  const words = s.split(/\s+/);
  const plainSingular = words.length <= 3 && !/^\d/.test(s) && !s.includes(",") &&
    !words.some(w => /[^s]s$/i.test(w) && !/'s$/i.test(w));
  if (!plainSingular || /^(a|an|the|some|my|our)\s/i.test(s)) return s;
  return (/^[aeiou]/i.test(s) ? "an " : "a ") + s;
}

// Plurality comes from the last word, not the first: "Ida's Wonder Horn" is one
// thing, "Custom Bronze Dog Totems" is several, and a leading count settles it.
export function piecePhrase(raw){
  const lead = /^(\d+)\s+/.exec(String(raw || ""));
  const name = String(raw || "").replace(/^\d+\s+/, "").trim() || String(raw || "");
  const last = name.split(/\s+/).pop() || "";
  const many = (lead ? Number(lead[1]) > 1 : false) || (/[^s]s$/i.test(last) && !/'s$/i.test(last));
  return { name, has: many ? "have" : "has", it: many ? "they" : "it",
           them: many ? "them" : "it", their: many ? "their" : "its",
           is: many ? "are" : "is", does: many ? "do" : "does" };
}

// Stable choice, so the same person never gets a different letter twice.
export function pick(seed, list){
  let h = 0;
  for (const c of String(seed || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return list[h % list.length];
}

/* ---------- helpers the letters lean on ---------- */

const isJewelry = p => /ring|cuff|pendant|chain|earring|talisman|key|egg/i.test(String(p || ""));
const firstPiece = p => ((String(p || "").split(",")[0]) || "").trim().replace(/\s*[\u00d7x]\d+$/, "");
const countPieces = p => String(p || "").split(",").map(s => s.trim()).filter(Boolean).length;

export function emailCtx(d){
  const raw = firstPiece(d.pieces) || "your piece";
  const pp = piecePhrase(raw);          // count stripped, agreement available
  return {
    first:firstName(d.name),
    piece:pp.name,
    pp,
    city:(d.location||"").split(",")[0].trim(),
    gift:d.gift_self==="Gift",
    repeat:countPieces(d.pieces)>=2,
    vip:!!d.first_look,
    jewel:isJewelry(firstPiece(d.pieces))
  };
}

/* ---------- the letters ---------- */

export const TONES=[
  {name:"Warm", build:c=>({
    subject:`Thinking of you & your ${c.piece}`,
    body:[
      `Hi ${c.first},`,"",
      c.jewel?`It's Alex and Hannah from Maçon. We were just thinking about you and wondering how ${c.piece} has been wearing${c.city?` out in ${c.city}`:""}.`
      :`It's Alex and Hannah from Maçon. We were just thinking about you and wondering how ${c.piece} is settling in${c.city?` over in ${c.city}`:""}.`,"",
      c.gift?(c.jewel?`Did it land the way you hoped? Has it been worn yet?`:`Did it land the way you hoped with the person you gave it to?`)
      :c.repeat?`You've quietly built a little collection now, which honestly makes us so happy. What keeps pulling you back?`
      :c.jewel?`Has it made it into the rotation yet? We love picturing where our pieces get worn.`
      :`Where's it ended up living? On you, a shelf, somewhere it can keep an eye on things?`,"",
      `Even a one-line reply would make our week. Truly no pressure.`,
      ...(c.vip?["","And if you ever catch it in good light, we'd love to see it."]:[]),
      "",
      `Warmly,`,`Alex & Hannah`
    ].join("\n")
  })},
  {name:"Casual", build:c=>({
    subject:`Quick q about your ${c.piece}`,
    body:[
      `Hey ${c.first},`,"",
      `Hope you're doing well! It's Alex from Maçon. ${c.piece} popped into my head today and I got curious.`,"",
      c.gift?`Did the person you gave it to take to it?`
      :c.jewel?`Where's it been going with you? Out a lot, or saving it for the right days?`
      :c.vip?`Where's it living these days? I keep wondering where it ended up.`
      :`Where'd it end up? Did it find a little spot yet?`,"",
      `No need to write much, a line or two would make my day.`,"",
      `x Alex`
    ].join("\n")
  })},
  {name:"Heartfelt", build:c=>({
    subject:`A little note about your ${c.piece}`,
    body:[
      `Dear ${c.first},`,"",
      `It's Hannah, from Maçon. Making ${c.piece} for you meant a lot to us, and we love knowing where our little objects end up in people's lives.`,"",
      c.gift?`I've been wondering how it was received by the person you chose it for.`
      :c.jewel?`I'd love to know how it feels to wear, and where it's been with you.`
      :`I'd love to know where it lives now, and what it's come to mean to you.`,"",
      `Whatever you feel like sharing, we'd hold onto it.`,
      ...(c.vip?["","And if you ever snap a photo of it where it lives, we'd treasure that too."]:[]),
      "",
      `With love,`,`Alex & Hannah`
    ].join("\n")
  })},
  {name:"Brief", build:c=>({
    subject:`${c.piece} :)`,
    body:[
      `Hi ${c.first},`,"",
      `Alex & Hannah from Maçon here. Quick one: ${c.gift?`did your gift land okay?`:c.jewel?`has ${c.piece} been getting worn?`:`where's ${c.piece} ended up living?`}`,"",
      `Thank you, really.`,`Alex & Hannah`
    ].join("\n")
  })}
];

// Reconnect: presence only, no ask, just a note that they are on our minds
export const RECON_TONES=[
  {name:"Warm", build:c=>({
    subject:`Thinking of you, ${c.first}`,
    body:[
      `Hi ${c.first},`,"",
      `It's Alex and Hannah from Maçon. No news and no ask, you just crossed our minds today and we wanted to say hello${c.city?` over in ${c.city}`:""}.`,"",
      `We hope ${c.piece} is still keeping good company, and that you're well.`,"",
      `Warmly,`,`Alex & Hannah`
    ].join("\n")
  })},
  {name:"Brief", build:c=>({
    subject:`Hello from Maçon`,
    body:[
      `Hi ${c.first},`,"",
      `Just a quiet hello from Alex & Hannah, you've been on our minds. No need to reply, we only wanted you to know.`,"",
      `Warmly,`,`Alex & Hannah`
    ].join("\n")
  })}
];

export const CUSTOM_TONES=[
  {name:"Revive", build:q=>{
    const f=firstName(q.name), a=q.subject;
    return q.repeat_buyer ? {
      subject:`Re: your ${a}`,
      body:[`Hey ${f},`,"",
        `I never circled back about the ${a}, which I regret, it's a good one.`,"",
        `If you're still up for it, I'd like to draw a couple of options and send them over. No commitment, and no need to decide anything from a drawing.`,"",
        `Hannah`].join("\n")
    } : {
      subject:`Re: your ${a}`,
      body:[`Hi ${f},`,"",
        `I never followed up on your ${a}, and I should have.`,"",
        `If it was the price or the size of the deposit, I would genuinely like to know, it helps us. And if you're still interested, I'd like to draw it for you before you decide anything at all.`,"",
        `Either way, thanks for writing in ${monthOf(q.first_seen)}.`,"",
        `Hannah`].join("\n")
    };
  }},
  {name:"Nudge", build:q=>({
    subject:`Re: your ${q.subject}`,
    body:[`Hi ${firstName(q.name)},`,"",
      `Still thinking about your ${q.subject}.`,"",
      `Want me to sketch something?`,"",
      `Hannah`].join("\n")
  })},
  {name:"First reply", build:q=>{
    const f=firstName(q.name), a=q.subject;
    return q.repeat_buyer ? {
      subject:`Re: your ${a}`,
      body:[`Hey ${f},`,"",
        `Yes, a ${a}, absolutely.`,"",
        `Do you have a particular ${a} in mind, or should we invent one?`,"",
        `One thing worth mentioning since it has been a while: customs are $925 now. We slowed the process down a lot last year, more time on the carving and much more hand filing, and the price followed the work.`,"",
        `Tell me about the ${a} and I'll get things moving.`,"",
        `Hannah`].join("\n")
    } : {
      subject:`Re: your ${a}`,
      body:[`Hi ${f},`,"",
        `We'd love to make ${a.match(/^[aeiou]/i)?"an":"a"} ${a} for you.`,"",
        `Tell me about yours first. Is there a particular ${a} you have in mind, or would you rather we invent one? Photos help if you have any, though they are not necessary.`,"",
        `I've attached a few customs we've made so you can see where these tend to land.`,"",
        `How it works: Alex and I design the form together, I carve it in wax, it goes to our foundry here in L.A. to be lost-wax cast in bronze, then I file the whole surface by hand, honing the facets, and patinate and wax it. About three weeks from start to mailing, and a custom bronze totem is $925.`,"",
        `Nothing to decide yet. Tell me about your ${a} and we'll go from there.`,"",
        `Hannah`].join("\n")
    };
  }}
];

/* ---------- what each surface asks for ---------- */

// One letter per enquiry, chosen by where the thread actually is.
export function enquiryDraft(q, days){
  if (q.draft) return { subject: "Re: " + (q.subject || "your commission"), body: q.draft };
  // A reply recorded in the note counts as contact: most replies happen in
  // Gmail and never touch the app.
  const answered = !!q.last_touched || /replied|reply|answered|wrote back|sent/i.test(String(q.note || ""));
  const want = !answered ? "First reply" : days < 30 ? "Nudge" : "Revive";
  const set = CUSTOM_TONES.find(t => t.name === want) || CUSTOM_TONES[0];
  return set.build(q);
}
export function collectorDraft(d, kind){
  const c = emailCtx(d);
  const set = kind === "reconnect" ? RECON_TONES : TONES;
  return pick(d.name || d.acc || "", set).build(c);
}
