/* PixelWalk pixel-art converter. Pure functions on RGBA arrays (browser + Node).
   Pipeline: crop → coarse art grid → OKLab k-means palette → dominant colour
   per cell → despeckle → 1-cell selective outline → integer nearest upscale.
   Output: a 160×160 RGBA tile with binary alpha, bottom-centred. */
(function(root){
'use strict';
const TILE=160;
const config=root.PixelWalkConfig||(typeof require==='function'?require('./settings.js'):null),settings=config.values;
// Per size: on-tile max extent, art-pixel block (tile px), palette size.
const SIZES=Object.fromEntries([['small',32,'colorsSmall'],['medium',64,'colorsMedium'],['large',112,'colorsLarge'],['giant',160,'colorsGiant']].map(([size,max,key])=>[size,{max,block:Math.max(1,Math.round(config.artwork.pixelBase*(max/TILE)**config.artwork.pixelExponent)),colors:settings[key]}]));

/* ---------- colour ---------- */
const toLin=c=>{c/=255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4};
const toSrgb=c=>{c=c<=.0031308?c*12.92:1.055*c**(1/2.4)-.055;return Math.max(0,Math.min(255,Math.round(c*255)))};
const LIN=new Float64Array(256).map((_,i)=>toLin(i));
function oklab(r,g,b){r=LIN[r];g=LIN[g];b=LIN[b];
 const l=Math.cbrt(.4122214708*r+.5363325363*g+.0514459929*b),m=Math.cbrt(.2119034982*r+.6806995451*g+.1073969566*b),s=Math.cbrt(.0883024619*r+.2817188376*g+.6299787005*b);
 return [.2104542553*l+.793617785*m-.0040720468*s,1.9779984951*l-2.428592205*m+.4505937099*s,.0259040371*l+.7827717662*m-.808675766*s]}
function rgb([L,a,b]){const l=(L+.3963377774*a+.2158037573*b)**3,m=(L-.1055613458*a-.0638541728*b)**3,s=(L-.0894841775*a-1.291485548*b)**3;
 return [toSrgb(4.0767416621*l-3.3077115913*m+.2309699292*s),toSrgb(-1.2684380046*l+2.6097574011*m-.3413193965*s),toSrgb(-.0041960863*l-.7034186147*m+1.707614701*s)]}
const dist=(p,q)=>(p[0]-q[0])**2+(p[1]-q[1])**2+(p[2]-q[2])**2;
function nearest(c,pal){let best=0,d=Infinity;for(let i=0;i<pal.length;i++){const e=dist(c,pal[i]);if(e<d){d=e;best=i}}return best}

/* Deterministic k-means++ in OKLab; merges near-duplicate centres. */
function palette(samples,k){
 if(samples.length<=k)return samples.map(s=>s.slice());
 let seed=1234567;const rand=()=>(seed=(seed*1103515245+12345)>>>0)/4294967296;
 const centres=[samples[Math.floor(samples.length/2)].slice()],d2=new Float64Array(samples.length).fill(Infinity);
 while(centres.length<k){let total=0;const c=centres[centres.length-1];for(let i=0;i<samples.length;i++){d2[i]=Math.min(d2[i],dist(samples[i],c));total+=d2[i]}
  if(total<1e-9)break;let r=rand()*total,i=0;while(i<samples.length-1&&(r-=d2[i])>0)i++;centres.push(samples[i].slice())}
 const assign=new Int32Array(samples.length);
 for(let iter=0;iter<12;iter++){const sum=centres.map(()=>[0,0,0,0]);
  for(let i=0;i<samples.length;i++){const j=nearest(samples[i],centres);assign[i]=j;const s=sum[j];s[0]+=samples[i][0];s[1]+=samples[i][1];s[2]+=samples[i][2];s[3]++}
  let moved=0;for(let j=0;j<centres.length;j++)if(sum[j][3]){const n=[sum[j][0]/sum[j][3],sum[j][1]/sum[j][3],sum[j][2]/sum[j][3]];moved+=dist(n,centres[j]);centres[j]=n}
  if(moved<1e-8)break}
 const merged=[];for(const c of centres)if(!merged.some(m=>dist(m,c)<.0009))merged.push(c);
 // Gentle pixel-art grading: a touch more chroma so flat colours read clearly.
 return merged.map(([L,a,b])=>[L,a*1.12,b*1.12]);
}
// Selective outline: a darker, slightly desaturated shade of the touching colour.
const shade=([L,a,b])=>[Math.max(.08,L*.48),a*.75,b*.75];

/* ---------- background ---------- */
/* Uploads arrive with a flat opaque background, or letterboxed, and both leave
   pixelate() unable to tell the subject from the frame: a fully opaque image
   fails the transparency check outright, and bars inside the alpha bounds
   stretch those bounds until the subject shrinks to a fraction of the tile.
   Trim opaque near-uniform borders first, so the bounds step below sees roughly
   what a hand cut-out would give it. Flat white, flat black, solid
   colours and letterbox bars come off; gradient, textured and photographic
   backgrounds are left alone and still fail. A uniform band that genuinely
   spans a whole row or column of the artwork cannot be told apart from a
   border and is trimmed with it, which is what the studio preview catches. */
const TRIM={tolerance:12,maxTrim:.45,opaque:250};
// One row (step 1, count W) or one column (step W, count H) of effectively one
// opaque colour. Any partial alpha, or drift past the tolerance, ends the scan.
function uniformLine(data,start,step,count,tolerance){
 const r=data[start],g=data[start+1],b=data[start+2];
 for(let i=1;i<count;i++){const o=start+i*step*4;
  if(data[o+3]<TRIM.opaque)return false;
  if(Math.abs(data[o]-r)>tolerance||Math.abs(data[o+1]-g)>tolerance||Math.abs(data[o+2]-b)>tolerance)return false}
 return true;
}
/* Returns the cropped source, or null unless all four scans stopped at content
   rather than at the cap. That is the evidence the remaining box is the subject
   itself, and it is also what lets pixelate() accept a source with no
   transparent margin left -- so a blank or near-blank frame, which only ever
   ends at the cap, must not qualify. */
function trimBorders(src,{tolerance=TRIM.tolerance,maxTrim=TRIM.maxTrim}={}){
 const {width:W,height:H,data}=src,maxY=Math.floor(H*maxTrim),maxX=Math.floor(W*maxTrim);
 let top=0;while(top<maxY&&uniformLine(data,top*W*4,1,W,tolerance))top++;
 let bottom=0;while(bottom<maxY&&uniformLine(data,(H-1-bottom)*W*4,1,W,tolerance))bottom++;
 let left=0;while(left<maxX&&uniformLine(data,left*4,W,H,tolerance))left++;
 let right=0;while(right<maxX&&uniformLine(data,(W-1-right)*4,W,H,tolerance))right++;
 if(top===maxY||bottom===maxY||left===maxX||right===maxX)return null;
 const w=W-left-right,h=H-top-bottom;
 if((!top&&!bottom&&!left&&!right)||w<1||h<1)return null;
 const out=new Uint8ClampedArray(w*h*4);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){const s=((y+top)*W+left+x)*4,d=(y*w+x)*4;
  out[d]=data[s];out[d+1]=data[s+1];out[d+2]=data[s+2];out[d+3]=data[s+3]}
 return {width:w,height:h,data:out};
}

/* ---------- main ---------- */
function fail(message){const e=new Error(message);e.userFacing=true;throw e}
function pixelate(source,size='medium'){
 // Only a crop that shortened both axes is a box around the subject; it has no
 // transparent margin left to measure, so the ratio below cannot apply to it.
 // A one-axis crop still has an unbounded direction, which is exactly the
 // letterbox case -- there the bounds step below does the separating, and the
 // ratio keeps applying as before.
 const src=trimBorders(source)||source;
 const separated=src!==source&&src.width<source.width&&src.height<source.height;
 const {width:W,height:H,data}=src,cfg=SIZES[size]||SIZES.medium;
 let x0=W,y0=H,x1=-1,y1=-1,clear=0;
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){const a=data[(y*W+x)*4+3];if(a<32)clear++;if(a>=128){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y}}
 if(x1<0)fail('没有找到可见主体');
 if(!separated&&clear/(W*H)<.01)fail(clear?'透明边距太窄，请给主体留出更宽的透明背景':'需要透明背景');
 const bw=x1-x0+1,bh=y1-y0+1;
 // Art grid leaves one cell on each side for the outline.
 const inner=Math.max(4,Math.floor(cfg.max/cfg.block)-2),k=inner/Math.max(bw,bh);
 const cols=Math.max(1,Math.round(bw*k)),rows=Math.max(1,Math.round(bh*k)),gw=cols+2,gh=rows+2;
 // 1) per cell: coverage + subsampled OKLab pixels.
 const cells=new Array(cols*rows),pool=[];
 for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
  const sx0=x0+c*bw/cols,sx1=x0+(c+1)*bw/cols,sy0=y0+r*bh/rows,sy1=y0+(r+1)*bh/rows;
  const ix0=Math.floor(sx0),ix1=Math.max(ix0+1,Math.ceil(sx1)),iy0=Math.floor(sy0),iy1=Math.max(iy0+1,Math.ceil(sy1));
  const step=Math.max(1,Math.floor(Math.sqrt((ix1-ix0)*(iy1-iy0)/64)));
  const px=[];let total=0;
  for(let y=iy0;y<iy1&&y<H;y+=step)for(let x=ix0;x<ix1&&x<W;x+=step){total++;const i=(y*W+x)*4;if(data[i+3]>=128)px.push(oklab(data[i],data[i+1],data[i+2]))}
  cells[r*cols+c]={cover:total?px.length/total:0,px};
  for(let i=0;i<px.length;i+=Math.max(1,Math.floor(px.length/12)))pool.push(px[i]);
 }
 const pal=palette(pool,cfg.colors);
 // 2) each cell takes its most frequent palette colour — no averaging, no blur.
 const grid=new Int16Array(gw*gh).fill(-1),at=(c,r)=>c<0||r<0||c>=gw||r>=gh?-1:grid[r*gw+c];
 for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){const cell=cells[r*cols+c];if(cell.cover<.42)continue;
  const votes=new Float64Array(pal.length);for(const p of cell.px)votes[nearest(p,pal)]++;
  let best=0;for(let i=1;i<votes.length;i++)if(votes[i]>votes[best])best=i;grid[(r+1)*gw+c+1]=best}
 // 3) despeckle: drop floating dust, fill pinholes, absorb lone off-colour cells.
 const N4=[[1,0],[-1,0],[0,1],[0,-1]],N8=[...N4,[1,1],[1,-1],[-1,1],[-1,-1]];
 const next=grid.slice();
 for(let r=1;r<gh-1;r++)for(let c=1;c<gw-1;c++){
  const v=at(c,r),n4=N4.map(([dx,dy])=>at(c+dx,r+dy)),n8=N8.map(([dx,dy])=>at(c+dx,r+dy));
  const filled=n8.filter(x=>x>=0);
  if(v>=0&&!n4.some(x=>x>=0)){next[r*gw+c]=-1;continue}
  const tally=new Map();for(const x of filled)tally.set(x,(tally.get(x)||0)+1);
  let major=-1,count=0;for(const [x,n] of tally)if(n>count){major=x;count=n}
  if(v<0){if(n4.every(x=>x>=0))next[r*gw+c]=major;continue}
  if(!n4.includes(v)&&count>=5)next[r*gw+c]=major;
 }
 grid.set(next);
 // 4) outline transparent cells that touch the sprite (4-neighbour).
 const colours=pal.map(rgb),outlines=pal.map(c=>rgb(shade(c)));
 const out=new Int16Array(gw*gh).fill(-1);
 for(let r=0;r<gh;r++)for(let c=0;c<gw;c++){if(at(c,r)>=0)continue;
  const touch=N4.map(([dx,dy])=>at(c+dx,r+dy)).filter(x=>x>=0);if(!touch.length)continue;
  // Darkest neighbour wins so outlines stay consistent along an edge.
  out[r*gw+c]=touch.reduce((a,b)=>pal[b][0]<pal[a][0]?b:a)}
 // 5) nearest-neighbour upscale onto the 160 tile, bottom-centred.
 const B=cfg.block,tile=new Uint8ClampedArray(TILE*TILE*4),ox=Math.floor((TILE-gw*B)/2),oy=TILE-gh*B;
 for(let r=0;r<gh;r++)for(let c=0;c<gw;c++){
  const v=grid[r*gw+c],o=out[r*gw+c];if(v<0&&o<0)continue;const col=v>=0?colours[v]:outlines[o];
  for(let y=0;y<B;y++)for(let x=0;x<B;x++){const tx=ox+c*B+x,ty=oy+r*B+y;if(tx<0||ty<0||tx>=TILE||ty>=TILE)continue;const i=(ty*TILE+tx)*4;tile[i]=col[0];tile[i+1]=col[1];tile[i+2]=col[2];tile[i+3]=255}
 }
 return {width:TILE,height:TILE,data:tile,grid:{cols:gw,rows:gh,block:B},colors:colours.length};
}
const api={pixelate,trimBorders,SIZES,TILE,oklab,rgb};
root.PixelWalkPixelate=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
