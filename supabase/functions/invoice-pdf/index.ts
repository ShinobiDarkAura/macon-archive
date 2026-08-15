// Maçon — invoice PDF renderer
//
// The sheet is drawn here rather than in the browser so the licensed typefaces
// never reach a client. Fontgrube permits web font formats for on-screen display
// but forbids offering the font software itself for download; TAY and LOMA carry
// no licence terms at all. The four TrueType files live in a private Storage
// bucket that only the service role can read.
//
// POST { invoice } -> application/pdf

import { PDFDocument, rgb, degrees } from "https://esm.sh/pdf-lib@1.17.1";
import fontkit from "https://esm.sh/@pdf-lib/fontkit@1.1.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const INV_PAPER="#FEFCF6", INV_INK="#1C1A18",
      INV_ORANGE="#E2661C", INV_LABEL="#9C8F76", INV_RULE="#E3DED0";

// Cached for the life of the isolate, so a warm call pays nothing for fonts.
const _cache = new Map<string, Uint8Array>();
async function asset(name: string): Promise<Uint8Array> {
  const hit = _cache.get(name); if (hit) return hit;
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/fonts/${name}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`asset ${name}: ${r.status}`);
  const b = new Uint8Array(await r.arrayBuffer());
  _cache.set(name, b);
  return b;
}

function invMath(v){
  const sub = (v.items||[]).reduce((a,l)=>a + (Number(l.qty)||0) * (Number(l.unit)||0), 0);
  const disc = sub * (Number(v.discount_pct)||0) / 100;
  const taxed = sub - disc;
  const tax = taxed * (Number(v.tax_pct)||0) / 100;
  return { sub, disc, taxed, tax, total: taxed + tax };
}
function invMoney(n){
  const r = Math.round(n*100)/100;
  return "$" + (Number.isInteger(r) ? r.toLocaleString("en-US")
    : r.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}));
}
function invDate(s){
  const t = Date.parse((s||"")+"T00:00:00"); if(isNaN(t)) return "";
  const d = new Date(t), p = n => String(n).padStart(2,"0");
  return `${p(d.getMonth()+1)}.${p(d.getDate())}.${String(d.getFullYear()).slice(2)}`;
}

function fitText(str, font, size, maxW){
  str=String(str||"");
  if(font.widthOfTextAtSize(str,size)<=maxW) return str;
  let s=str;
  while(s.length>1 && font.widthOfTextAtSize(s+"…",size)>maxW) s=s.slice(0,-1);
  return s.replace(/\s+$/,"")+"…";
}
// Wrap to at most maxLines, ellipsizing the last line if anything is left over.
function wrapText(str, font, size, maxW, maxLines){
  const words=String(str||"").trim().split(/\s+/).filter(Boolean);
  if(!words.length) return [];
  const lines=[]; let cur="";
  for(let i=0;i<words.length;i++){
    const t=cur?cur+" "+words[i]:words[i];
    if(font.widthOfTextAtSize(t,size)<=maxW){ cur=t; continue; }
    if(cur){ lines.push(cur); cur=words[i]; }
    else { lines.push(fitText(words[i],font,size,maxW)); cur=""; }
    if(lines.length===maxLines){
      const left=((cur?cur+" ":"")+words.slice(i+1).join(" ")).trim();
      if(left) lines[maxLines-1]=fitText(lines[maxLines-1]+" …",font,size,maxW);
      return lines;
    }
  }
  if(cur) lines.push(cur);
  return lines.slice(0,maxLines);
}

async function invoicePDF(v){
  const hex=h=>rgb(parseInt(h.slice(1,3),16)/255, parseInt(h.slice(3,5),16)/255, parseInt(h.slice(5,7),16)/255);

  const doc=await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const [flap, birdie, loma, gab] = await Promise.all([
    asset("tay-flapjack.ttf"), asset("tay-birdie.ttf"),
    asset("loma.ttf"), asset("gabriele-l.ttf")
  ]);
  // Birdie and Loma are embedded whole: pdf-lib's subsetter drops most outlines
  // from the OTF-to-TTF conversion, leaving blank text.
  // Every face is pre-subset to the glyphs this document can draw, so they are
  // embedded whole and pdf-lib's own subsetter is never involved. It drops
  // outlines from OTF-to-TTF conversions, which is what blanked Loma before.
  const F={ title:await doc.embedFont(flap,{subset:false}),
            caps: await doc.embedFont(birdie,{subset:false}),
            small:await doc.embedFont(loma,{subset:false}),
            type: await doc.embedFont(gab,{subset:false}) };

  const W=792, L=100, R=692, C1=152;
  const INK=hex(INV_INK), OR=hex(INV_ORANGE), LAB=hex(INV_LABEL), RULE=hex(INV_RULE);
  const m=invMath(v);
  const items=(v.items||[]).filter(l=>(l.desc||"").trim()||Number(l.unit));

  // Cost column sizes itself to the widest figure so its padding never changes.
  const COST_PAD=14;
  const costCells=[...items.map(l=>invMoney(Number(l.unit)||0)), invMoney(m.sub),
    ...(Number(v.discount_pct)?["−"+invMoney(m.disc)]:[]),
    ...(Number(v.tax_pct)?[invMoney(m.tax)]:[])];
  const costW=Math.max(52, ...costCells.map(t=>F.type.widthOfTextAtSize(t,11)))+COST_PAD*2;
  const C2=R-costW, COST_MID=(C2+R)/2, DESC_X=C1+16, DESC_W=C2-DESC_X-16;

  const totalsRows=[["Subtotal", invMoney(m.sub)]]
    .concat(Number(v.discount_pct) ? [[Number(v.discount_pct)+"% off", "−"+invMoney(m.disc)]] : [])
    .concat(Number(v.tax_pct) ? [["Tax "+Number(v.tax_pct)+"%", invMoney(m.tax)]] : []);

  // The sheet grows downward rather than spilling onto a second page. It starts
  // at landscape letter and stretches to at most 8.5 x 11 proportions; only past
  // that does it paginate.
  const BASE_H=612, MAX_H=Math.round(W*11/8.5), ROW=34, HDR_BASE=376, LAST_FLOOR=108;
  const capAt=dy=>Math.floor((HDR_BASE-10+dy-LAST_FLOOR)/ROW);
  const maxDy=MAX_H-BASE_H, maxRows=capAt(maxDy);
  const wanted=Math.max(items.length,4)+totalsRows.length;
  const singleDy=Math.max(0, Math.min(maxDy, ROW*wanted-(HDR_BASE-10-LAST_FLOOR)));

  let sheets, dy;
  if(wanted<=capAt(maxDy)){ sheets=[items]; dy=singleDy; }
  else {
    dy=maxDy;
    const lastCap=Math.max(1,maxRows-totalsRows.length), fullCap=maxRows;
    sheets=[]; let rest=items.slice();
    while(rest.length>lastCap) sheets.push(rest.splice(0,fullCap));
    sheets.push(rest);
    if(sheets.length>1 && !sheets[sheets.length-1].length) sheets[sheets.length-1].push(sheets[sheets.length-2].pop());
  }
  const H=BASE_H+dy;

  let sealPng=null;
  try{ sealPng=await doc.embedPng(await asset("red-stamp-alt.png")); }
  catch(e){ /* no seal on file, the document still stands */ }

  const trackedW=(t,font,size,tracking)=>{
    const cs=[...String(t)], base=c=>c==="Ç"?"C":c==="ç"?"c":c;
    return cs.reduce((a,c)=>a+font.widthOfTextAtSize(base(c),size)+tracking,0)-tracking;
  };

  sheets.forEach((sheetItems, si)=>{
    const page=doc.addPage([W,H]);
    const last = si===sheets.length-1;
    page.drawRectangle({x:0,y:0,width:W,height:H,color:hex(INV_PAPER)});

    // pdf-lib has no letter-spacing, so tracked caps are drawn glyph by glyph
    const tracked=(text,{font,size,color,x,y,tracking=0,align="left"})=>{
      const cs=[...String(text)], base=c=>c==="Ç"?"C":c==="ç"?"c":c;
      const w=trackedW(text,font,size,tracking);
      let cx = align==="center" ? x-w/2 : align==="right" ? x-w : x;
      for(const c of cs){
        const g=base(c);
        page.drawText(g,{x:cx,y,size,font,color});
        if(g!==c){
          // TAY Birdie has no cedilla of its own, so one is drawn: a comma
          // centred beneath the C.
          const cs2=size*0.95, gw=font.widthOfTextAtSize(g,size), mw=font.widthOfTextAtSize(",",cs2);
          page.drawText(",",{x:cx+(gw-mw)/2, y:y-size*0.13, size:cs2, font, color});
        }
        cx+=font.widthOfTextAtSize(g,size)+tracking;
      }
      return w;
    };
    const text=(t,{font,size,color,x,y,align="left",rotate=0})=>{
      const w=font.widthOfTextAtSize(String(t),size);
      const tx = align==="center" ? x-w/2 : align==="right" ? x-w : x;
      page.drawText(String(t),{x:tx, y, size, font, color, ...(rotate?{rotate:degrees(rotate)}:{})});
      return w;
    };
    const rule=(x1,x2,y,c=RULE,t=0.8)=>page.drawLine({start:{x:x1,y},end:{x:x2,y},thickness:t,color:c});

    // masthead and meta sit relative to the top, so they ride up as the sheet grows
    tracked("ARTIFACT",              {font:F.caps,size:9.5,color:INK,x:150,y:560+dy,tracking:2.4,align:"center"});
    tracked("INVOICING & REMITTANCE",{font:F.caps,size:9.5,color:INK,x:150,y:539+dy,tracking:2.4,align:"center"});
    tracked("FORM",                  {font:F.caps,size:9.5,color:INK,x:150,y:518+dy,tracking:2.4,align:"center"});
    tracked("MAÇON",                 {font:F.caps,size:9.5,color:INK,x:642,y:560+dy,tracking:2.4,align:"center"});
    tracked("BUREAU OF PROVENANCE",  {font:F.caps,size:9.5,color:INK,x:642,y:539+dy,tracking:2.4,align:"center"});
    tracked("2023",                  {font:F.caps,size:9.5,color:INK,x:642,y:518+dy,tracking:2.4,align:"center"});
    text("ARTIFACT",   {font:F.title,size:37,color:INK,x:396,y:548+dy,align:"center"});
    text("REQUISITION",{font:F.title,size:37,color:INK,x:396,y:514+dy,align:"center"});

    /* TO / INVOICE NO. / DATE. The TO cell stretches as its name grows and the
       other two give ground, but never past the point where their own figures
       keep 16pt of air either side. Beyond that the name truncates. */
    const metaY=424+dy, GAP=24, AVAIL=R-L-GAP*2, third=AVAIL/3;
    const metaFields=[["TO", v.bill_to||""],["INVOICE NO.", v.number||""],["DATE", invDate(v.issued_on)]];
    const labW=metaFields.map(([l])=>trackedW(l,F.caps,8.5,1.6));
    const need=i=>labW[i]+12+F.type.widthOfTextAtSize(String(metaFields[i][1]),13)+32;
    const floor2=need(1), floor3=need(2);
    let w1=Math.max(third, labW[0]+12+F.type.widthOfTextAtSize(String(metaFields[0][1]),13)+32);
    w1=Math.min(w1, AVAIL-floor2-floor3);
    w1=Math.max(w1, third*0.7);
    let rest=AVAIL-w1, w2=Math.max(floor2, rest/2), w3=rest-w2;
    if(w3<floor3){ w3=floor3; w2=rest-w3; }
    const widths=[w1,w2,w3], META_TILT=[-1.1,0.7,-0.6];
    let mx=L;
    metaFields.forEach(([label,val],i)=>{
      const x0=mx, x1=mx+widths[i]; mx=x1+GAP;
      const lw=tracked(label,{font:F.caps,size:8.5,color:INK,x:x0,y:metaY+4,tracking:1.6});
      const rx0=x0+lw+12, cellW=x1-rx0-4;
      let vs=13;
      while(vs>10 && F.type.widthOfTextAtSize(String(val),vs)>cellW) vs-=0.5;
      text(fitText(val,F.type,vs,cellW),
        {font:F.type,size:vs,color:OR,x:(rx0+x1)/2,y:metaY+2,align:"center",rotate:META_TILT[i]});
      rule(rx0-6,x1,metaY-6);
    });
    if(v.bill_addr) text(fitText(v.bill_addr,F.type,7,widths[0]),{font:F.type,size:7,color:LAB,x:L,y:404+dy});

    // table
    const hdr=HDR_BASE+dy;
    rule(L,R,hdr+18); rule(L,R,hdr-10);
    tracked("AMT.",                     {font:F.small,size:7,color:LAB,x:L+18,y:hdr,tracking:1.2});
    tracked("DESCRIPTION OF SERVICE(S)",{font:F.small,size:7,color:LAB,x:DESC_X,y:hdr,tracking:1.2});
    tracked("COST",                     {font:F.small,size:7,color:LAB,x:COST_MID,y:hdr,tracking:1.2,align:"center"});

    const rows = sheets.length===1 ? Math.max(sheetItems.length,4)
               : (last ? Math.max(sheetItems.length,1) : sheetItems.length);
    const y=hdr-10;
    for(let i=0;i<rows;i++){
      const rowY=y-ROW*i, mid=rowY-23, l=sheetItems[i];
      if(l){
        text("x"+(Number(l.qty)||0),{font:F.type,size:10,color:INK,x:L+18,y:mid});
        const ls=wrapText(l.desc,F.type,11,DESC_W,2), LH=13;
        ls.forEach((ln,k)=>text(ln,{font:F.type,size:11,color:INK,x:DESC_X,y:mid+((ls.length-1)/2)*LH-k*LH}));
        text(invMoney(Number(l.unit)||0),{font:F.type,size:11,color:INK,x:COST_MID,y:mid,align:"center"});
      }
      rule(L,R,rowY-ROW);
    }
    let ty=y-ROW*rows;
    if(last) totalsRows.forEach(([label,val])=>{
      const mid=ty-23;
      text(label,{font:F.type,size:10,color:INK,x:C2-18,y:mid,align:"right"});
      text(val,  {font:F.type,size:10,color:INK,x:COST_MID,y:mid,align:"center"});
      rule(L,R,ty-ROW); ty-=ROW;
    });
    page.drawLine({start:{x:C2,y:hdr+18},end:{x:C2,y:ty},thickness:0.8,color:RULE});
    page.drawLine({start:{x:C1,y:hdr+18},end:{x:C1,y:y-ROW*rows},thickness:0.8,color:RULE});
    page.drawLine({start:{x:L,y:hdr+18},end:{x:L,y:ty},thickness:0.8,color:RULE});
    page.drawLine({start:{x:R,y:hdr+18},end:{x:R,y:ty},thickness:0.8,color:RULE});

    // The seal lands on the table's last line and is struck last, over the top.
    // The left of the totals rows is always empty, so nothing is obscured.
    if(last && sealPng){
      const s=142, r=sealPng.height/sealPng.width, th=12*Math.PI/180, cx=136, cy=ty+17;
      page.drawImage(sealPng,{ x: cx-(s/2)*Math.cos(th)+(s*r/2)*Math.sin(th),
                               y: cy-(s/2)*Math.sin(th)-(s*r/2)*Math.cos(th),
                               width:s, height:s*r, rotate:degrees(12), opacity:0.92});
    }

    if(last){
      // Total due grows leftward: right edge pinned to the table's, with exactly
      // 32pt of air either side of the figure.
      const totalStr=invMoney(m.total)+"—";
      const tw=F.type.widthOfTextAtSize(totalStr,16);
      const tx1=R, tx0=tx1-(tw+64);
      tracked("TOTAL DUE",{font:F.caps,size:8.5,color:INK,x:tx0-14,y:82,tracking:1.4,align:"right"});
      text(totalStr,{font:F.type,size:16,color:OR,x:(tx0+tx1)/2,y:80,align:"center"});
      rule(tx0,tx1,70);
      if(v.notes) text(fitText(v.notes,F.type,9.5,420),{font:F.type,size:9.5,color:LAB,x:16,y:16});
    }
    if(sheets.length>1)
      tracked(`SHEET ${si+1} OF ${sheets.length}`,{font:F.small,size:7,color:LAB,x:R,y:16,tracking:1.2,align:"right"});
  });

  const bytes=await doc.save();
  const name=(v.number||"invoice")+" "+(v.bill_to||"").replace(/[^\w \-]/g,"").trim();
  return { bytes, filename:name.trim()+".pdf", width:W, height:H, pages:sheets.length };
}

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return new Response("POST an invoice", { status: 405, headers: cors });

  try {
    const v = await req.json();
    const { bytes, filename, width, height, pages } = await invoicePDF(v);
    return new Response(bytes, { status: 200, headers: { ...cors,
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename.replace(/"/g, "")}"`,
      "X-Sheet": `${width}x${height}`, "X-Pages": String(pages),
      "Cache-Control": "no-store" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500,
      headers: { ...cors, "Content-Type": "application/json" } });
  }
});
