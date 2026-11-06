import { normalizeMaterial, computeBufferSize, fitCover, PRESETS } from './core.mjs';
export { PRESETS } from './core.mjs';

const instances = new WeakMap();
const QUALITY = {
  low: { maxDpr: 1, maxPixels: 1200000, blurScale: .25 },
  balanced: { maxDpr: 1.5, maxPixels: 2500000, blurScale: .5 },
  high: { maxDpr: 2, maxPixels: 4000000, blurScale: .5 }
};
const VERTEX = '#version 300 es\nprecision highp float;\nout vec2 v_uv;\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);v_uv=p;gl_Position=vec4(p*2.0-1.0,0.,1.);}';
const BLUR = '#version 300 es\nprecision highp float;\nin vec2 v_uv;out vec4 outColor;uniform sampler2D u_image;uniform vec2 u_step;\nvoid main(){vec4 c=texture(u_image,v_uv)*.227027;c+=(texture(u_image,v_uv+u_step*1.384615)+texture(u_image,v_uv-u_step*1.384615))*.316216;c+=(texture(u_image,v_uv+u_step*3.230769)+texture(u_image,v_uv-u_step*3.230769))*.070270;outColor=c;}';
const GLASS = '#version 300 es\n'
+ 'precision highp float;\nin vec2 v_uv;out vec4 outColor;\n'
+ 'uniform sampler2D u_scene;uniform sampler2D u_blurred;\n'
+ 'uniform vec2 u_size;uniform vec4 u_rect;uniform vec4 u_radii;uniform vec2 u_pointer;\n'
+ 'uniform float u_bevel,u_refraction,u_roughness,u_tintOpacity,u_dispersion,u_highlight,u_pointerStrength;\n'
+ 'uniform vec3 u_tint;\n'
+ 'float sdf(vec2 p,vec2 b,vec4 radii){float r=p.x>0.?(p.y>0.?radii.z:radii.y):(p.y>0.?radii.w:radii.x);vec2 q=abs(p)-b+r;return min(max(q.x,q.y),0.)+length(max(q,0.))-r;}\n'
+ 'vec2 uv(vec2 p){return clamp(vec2(p.x/u_size.x,1.-p.y/u_size.y),vec2(.001),vec2(.999));}\n'
+ 'vec3 sampleScene(vec2 p){return mix(texture(u_scene,uv(p)).rgb,texture(u_blurred,uv(p)).rgb,u_roughness);}\n'
+ 'void main(){\n'
+ ' vec2 p=vec2(v_uv.x,1.-v_uv.y)*u_size;vec2 local=p-(u_rect.xy+u_rect.zw*.5);vec2 halfSize=u_rect.zw*.5;\n'
+ ' float d=sdf(local,halfSize,u_radii);float aa=max(fwidth(d),.45);float mask=1.-smoothstep(-aa,aa,d);if(mask<=0.)discard;\n'
+ ' vec2 gradient=vec2(sdf(local+vec2(.3,0.),halfSize,u_radii)-sdf(local-vec2(.3,0.),halfSize,u_radii),sdf(local+vec2(0.,.3),halfSize,u_radii)-sdf(local-vec2(0.,.3),halfSize,u_radii));\n'
+ ' vec2 outward=gradient/max(length(gradient),.00001);float edge=1.-smoothstep(0.,u_bevel,max(-d,0.));\n'
+ ' vec2 refracted=p-outward*u_refraction*edge*edge;vec3 color=sampleScene(refracted);\n'
+ ' if(u_dispersion>0.){vec2 dispersion=outward*u_dispersion*edge;color.r=sampleScene(refracted+dispersion).r;color.b=sampleScene(refracted-dispersion).b;}\n'
+ ' float lum=dot(color,vec3(.2126,.7152,.0722));color=mix(vec3(lum),color,1.08);color=mix(color,u_tint,u_tintOpacity);\n'
+ ' vec3 normal=normalize(vec3(outward*edge*.8,sqrt(max(.06,1.-edge*edge*.64))));\n'
+ ' vec3 light=normalize(vec3(-.5,-.7,.8));vec2 delta=(u_pointer-p)/max(u_size.x,u_size.y);vec3 pointerLight=normalize(vec3(delta*3.,.7));\n'
+ ' float spec=pow(max(dot(normal,light),0.),24.);spec+=pow(max(dot(normal,pointerLight),0.),36.)*u_pointerStrength*.6;\n'
+ ' float rim=1.-smoothstep(.3,1.5,max(-d,0.));float directional=.25+.75*max(dot(outward,normalize(vec2(-.5,-.8))),0.);\n'
+ ' color+=vec3((spec*edge*.45+rim*directional*.65)*u_highlight);color-=vec3(edge*.018);\n'
+ ' outColor=vec4(clamp(color,0.,1.)*mask,mask);\n'
+ '}\n';

function program(gl, vertexSource, fragmentSource) {
  const shaders=[];
  try {
    for (const [kind,source] of [[gl.VERTEX_SHADER,vertexSource],[gl.FRAGMENT_SHADER,fragmentSource]]) {
      const shader=gl.createShader(kind);
      if (!shader) throw new Error('Shader allocation failed');
      shaders.push(shader);gl.shaderSource(shader,source);gl.compileShader(shader);
      if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader)||'Shader compilation failed');
    }
    const result=gl.createProgram();
    if (!result) throw new Error('Program allocation failed');
    shaders.forEach(s=>gl.attachShader(result,s));gl.linkProgram(result);
    if (!gl.getProgramParameter(result,gl.LINK_STATUS)) {const message=gl.getProgramInfoLog(result);gl.deleteProgram(result);throw new Error(message||'Shader linking failed');}
    return result;
  } finally { shaders.forEach(s=>gl.deleteShader(s)); }
}
function texture(gl) {
  const value=gl.createTexture();if(!value)throw new Error('Texture allocation failed');
  gl.bindTexture(gl.TEXTURE_2D,value);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  return value;
}
function sourceSize(source) {
  return { width:source?.videoWidth||source?.naturalWidth||source?.width||0,height:source?.videoHeight||source?.naturalHeight||source?.height||0 };
}
function video(source) { return typeof HTMLVideoElement!=='undefined' && source instanceof HTMLVideoElement; }
function validSource(source) {
  return ['HTMLCanvasElement','HTMLImageElement','HTMLVideoElement','ImageBitmap','OffscreenCanvas'].some(name=>typeof globalThis[name]==='function'&&source instanceof globalThis[name]);
}
function radius(value,size) {const first=parseFloat(value)||0;return value.trim().endsWith('%')?first*size/100:first;}
function axisAligned(style) {
  if(style.rotate&&style.rotate!=='none'&&parseFloat(style.rotate.trim().split(/\s+/).at(-1))!==0)return false;
  if(style.scale&&style.scale!=='none'){
    const values=style.scale.split(/\s+/).map(Number),x=values[0],y=values[1]??x;
    if(!Number.isFinite(x)||!Number.isFinite(y)||x<=0||y<=0||Math.abs(x-y)>.0001)return false;
  }
  if(style.transform==='none')return true;
  try{const m=new DOMMatrixReadOnly(style.transform);return m.is2D&&Math.abs(m.b)<.0001&&Math.abs(m.c)<.0001&&m.a>0&&m.d>0&&Math.abs(m.a-m.d)<.0001;}catch{return false;}
}
function circularCorners(element,style) {
  return ['borderTopLeftRadius','borderTopRightRadius','borderBottomRightRadius','borderBottomLeftRadius'].every(key=>{
    const values=style[key].trim().split(/\s+/);
    return Math.abs(radius(values[0],element.offsetWidth)-radius(values[1]||values[0],element.offsetHeight))<.1;
  });
}
function geometrySupported(element,root) {
  for (let current=element;current&&current!==root;current=current.parentElement) {
    const style=getComputedStyle(current);
    if(style.clipPath!=='none'||style.maskImage!=='none'||style.perspective!=='none')return false;
    if(!axisAligned(style))return false;
    if((current===element||current.classList.contains('lg-surface'))&&!circularCorners(current,style))return false;
    if(current!==element&&[style.overflowX,style.overflowY].some(v=>v!=='visible'))return false;
    if(Number(style.opacity)<.999)return false;
  }
  return true;
}

/**
 * One WebGL2 renderer per scene root. Pixels come ONLY from the explicit source;
 * DOM text and controls remain accessible HTML and never become a GPU texture.
 */
export class LiquidGlass {
  constructor({ root, source=null, selector='[data-glass]', quality='auto', mode='auto', fit='cover', dynamic, onStatus, background='#e8e9ef' }={}) {
    if(!(root instanceof HTMLElement))throw new TypeError('root must be an HTMLElement');
    if(instances.has(root))throw new Error('This root already owns a LiquidGlass engine');
    if(!['auto','low','balanced','high'].includes(quality))throw new TypeError('Unknown quality');
    if(!['auto','css','opaque'].includes(mode))throw new TypeError('Unknown mode');
    if(source!==null&&!validSource(source))throw new TypeError('Use an image, video, canvas, OffscreenCanvas or ImageBitmap source');
    if(!['cover','contain'].includes(fit))throw new TypeError('fit must be cover or contain');
    root.querySelectorAll(selector); // Validate before touching the caller's DOM.
    this.root=root;this.selector=selector;this.quality=quality;this.mode=mode;this.onStatus=onStatus;this.background=background;
    this._effectiveQuality=quality==='auto'?'balanced':quality;this._surfaces=new Map();this._removedAuto=new WeakSet();this._listeners=[];this._sourceListeners=[];
    this._destroyed=false;this._inView=true;this._frame=0;this._motionUntil=0;this._geometryDirty=true;this._sourceDirty=true;this._blurDirty=true;
    this._source=null;this._sourceReady=false;this._sourceError=null;this._dynamic=false;this._fit=fit;this._videoFrame=0;this._lastVideoTime=-1;
    this._contextLost=false;this._gl=null;this._resources=null;this._status={mode:'css',reason:'initializing'};
    this._pointer={x:0,y:0,targetX:0,targetY:0,strength:0,targetStrength:0};
    this._stats={frames:0,drawCalls:0,sourceUploads:0,blurPasses:0,submitMs:0};
    this._oldRootClass=root.classList.contains('lg-root');this._oldRootMode=root.getAttribute('data-lg-mode');
    this._oldRootPosition=root.style.position;this._changedPosition=getComputedStyle(root).position==='static';
    if(this._changedPosition)root.style.position='relative';
    root.classList.add('lg-root');
    this.backdrop=document.createElement('canvas');this.canvas=document.createElement('canvas');
    this.backdrop.className='lg-backdrop';this.canvas.className='lg-renderer';
    for(const el of [this.backdrop,this.canvas]){el.setAttribute('aria-hidden','true');el.setAttribute('role','presentation');}
    root.prepend(this.backdrop,this.canvas);
    this._ctx=this.backdrop.getContext('2d',{alpha:false});
    this._reducedTransparency=matchMedia('(prefers-reduced-transparency: reduce)');
    this._reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
    this._forcedColors=matchMedia('(forced-colors: active)');
    this._highContrast=matchMedia('(prefers-contrast: more)');
    for(const query of [this._reducedTransparency,this._reducedMotion,this._forcedColors,this._highContrast])this._listen(query,'change',()=>{this._geometryDirty=true;this.invalidate();});
    this._listen(this.canvas,'webglcontextlost',event=>{event.preventDefault();this._contextLost=true;this._resources=null;cancelAnimationFrame(this._frame);this._frame=0;const desired=this._desired();this._fallback(desired.mode,desired.reason);});
    this._listen(this.canvas,'webglcontextrestored',()=>{this._contextLost=false;this._initGL();this._sourceDirty=true;this._geometryDirty=true;this.invalidate();});
    this._initGL();
    this._resize=new ResizeObserver(()=>{this._geometryDirty=true;this._sourceDirty=true;this.invalidate();});
    this._resize.observe(root);
    this._intersection=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{
      const entry=entries.find(item=>item.target===root);if(!entry||entry.isIntersecting===this._inView)return;
      this._inView=entry.isIntersecting;
      if(!this._inView){cancelAnimationFrame(this._frame);this._frame=0;this._cancelVideo();}
      else{this._geometryDirty=true;this._sourceDirty=true;this._startVideo();this.invalidate();}
    }):null;
    this._intersection?.observe(root);
    this._listen(window,'resize',()=>{this._geometryDirty=true;this.invalidate();});
    this._listen(window,'scroll',()=>{this._geometryDirty=true;this.invalidate();},true);
    if(window.visualViewport)this._listen(window.visualViewport,'resize',()=>{this._geometryDirty=true;this.invalidate();});
    this._listen(document,'visibilitychange',()=>{
      if(document.hidden){cancelAnimationFrame(this._frame);this._frame=0;this._cancelVideo();}
      else{this._geometryDirty=true;this._sourceDirty=true;this._startVideo();this.invalidate();}
    });
    this._listen(root,'pointermove',event=>{
      if(this._reducedMotion.matches)return;
      const r=this.backdrop.getBoundingClientRect();this._pointer.targetX=event.clientX-r.left;this._pointer.targetY=event.clientY-r.top;this._pointer.targetStrength=1;this.invalidate();
    },{passive:true});
    this._listen(root,'pointerleave',()=>{this._pointer.targetStrength=0;this.invalidate();},{passive:true});
    this._listen(root,'pointerdown',()=>this.trackMotion(400),{passive:true});
    this._listen(root,'pointerup',()=>this.trackMotion(400),{passive:true});
    this._listen(root,'transitionrun',()=>this.trackMotion(1200),true);
    this._listen(root,'animationstart',()=>this.trackMotion(1200),true);
    this._mutation=new MutationObserver(records=>{
      if(records.some(r=>r.type==='childList'||r.attributeName==='data-glass'))this.refresh();
      this._geometryDirty=true;this.invalidate();
    });
    this._mutation.observe(root,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style','data-glass','hidden']});
    instances.set(root,this);
    this.refresh();this.setSource(source,{fit,dynamic});this.invalidate();
  }
  _listen(target,type,handler,options) {target.addEventListener(type,handler,options);this._listeners.push(()=>target.removeEventListener(type,handler,options));}
  _alive(){if(this._destroyed)throw new Error('LiquidGlass was destroyed');}
  get stats(){return {...this._stats,...this._status,quality:this._effectiveQuality,surfaceCount:this._surfaces.size,width:this.canvas.width,height:this.canvas.height};}
  get status(){return {...this._status};}
  _statusChanged(mode,reason) {
    if(this._status.mode===mode&&this._status.reason===reason)return;
    this._status={mode,reason};this.root.setAttribute('data-lg-mode',mode);
    try{this.onStatus?.(this.status);}catch(error){console.error('LiquidGlass onStatus callback failed',error);}
    this.root.dispatchEvent(new CustomEvent('liquidglass:status',{detail:this.status}));
  }
  _desired() {
    if(this.mode==='opaque'||this._reducedTransparency.matches||this._forcedColors.matches||this._highContrast.matches)return {mode:'opaque',reason:'accessibility-or-manual'};
    if(this.mode==='css')return {mode:'css',reason:'manual'};
    if(this._contextLost)return {mode:'css',reason:'context-lost'};
    if(!this._gl||!this._resources)return {mode:'css',reason:'webgl2-unavailable'};
    if(this._sourceError)return {mode:'css',reason:this._sourceError};
    if(!this._source||!this._sourceReady)return {mode:'css',reason:this._source?'source-loading':'source-required'};
    return {mode:'webgl',reason:'ready'};
  }
  _fallback(mode,reason) {
    if(!this.canvas.hidden)this.canvas.hidden=true;
    this._stats.drawCalls=0;
    for(const surface of this._surfaces.values())surface.el.setAttribute('data-lg-surface',mode);
    this._statusChanged(mode,reason);
  }
  _initGL() {
    try {
      const gl=this.canvas.getContext('webgl2',{alpha:true,antialias:false,depth:false,stencil:false,premultipliedAlpha:true,preserveDrawingBuffer:false,powerPreference:'low-power'});
      if(!gl||!this._ctx)throw new Error('WebGL2 or Canvas2D unavailable');
      this._gl=gl;this._disposeGPU();
      const resources={programs:[],textures:[],framebuffers:[],vao:null};this._resources=resources;
      resources.blur=program(gl,VERTEX,BLUR);resources.programs.push(resources.blur);
      resources.glass=program(gl,VERTEX,GLASS);resources.programs.push(resources.glass);
      resources.scene=texture(gl);resources.textures.push(resources.scene);
      resources.ping=texture(gl);resources.textures.push(resources.ping);
      resources.pong=texture(gl);resources.textures.push(resources.pong);
      resources.pingFBO=gl.createFramebuffer();resources.pongFBO=gl.createFramebuffer();resources.framebuffers.push(resources.pingFBO,resources.pongFBO);
      if(!resources.pingFBO||!resources.pongFBO)throw new Error('Framebuffer allocation failed');
      resources.vao=gl.createVertexArray();gl.bindVertexArray(resources.vao);
      resources.blurUniforms=Object.fromEntries(['u_image','u_step'].map(name=>[name,gl.getUniformLocation(resources.blur,name)]));
      resources.uniforms=Object.fromEntries(['u_scene','u_blurred','u_size','u_rect','u_radii','u_pointer','u_bevel','u_refraction','u_roughness','u_tintOpacity','u_dispersion','u_highlight','u_pointerStrength','u_tint'].map(name=>[name,gl.getUniformLocation(resources.glass,name)]));
      this._maxSize=Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE),gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),8192);
      this._bufferKey='';this._sourceDirty=true;this._blurDirty=true;
      gl.disable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);
    }catch{this._disposeGPU();this._fallback('css','webgl2-unavailable');}
  }
  _disposeGPU() {
    const gl=this._gl,r=this._resources;if(!gl||!r)return;
    if(!this._contextLost){r.programs?.forEach(p=>gl.deleteProgram(p));r.textures?.forEach(t=>gl.deleteTexture(t));r.framebuffers?.forEach(f=>gl.deleteFramebuffer(f));if(r.vao)gl.deleteVertexArray(r.vao);}
    this._resources=null;
  }
  refresh() {
    this._alive();
    const found=new Set(this.root.querySelectorAll(this.selector));
    for(const [el,s] of this._surfaces)if(!this.root.contains(el)||(s.auto&&!found.has(el)))this.detach(el,{suppressAuto:false});
    for(const el of found){
      const preset=el.getAttribute('data-glass')||'regular';
      if(!this._surfaces.has(el)){if(!this._removedAuto.has(el))this.attach(el,{preset,_auto:true});}
      else {const s=this._surfaces.get(el);if(s.auto&&s.attributePreset!==preset){s.material=normalizeMaterial(preset);s.attributePreset=preset;}}
    }
    this._geometryDirty=true;this.invalidate();return this;
  }
  attach(el,options={}) {
    this._alive();
    if(!(el instanceof HTMLElement)||!this.root.contains(el)||el===this.root)throw new TypeError('Surface must be an HTML descendant of root');
    if(this._surfaces.has(el))return this._surfaces.get(el).handle;
    this._removedAuto.delete(el);
    if(options===null)options={};
    const material=normalizeMaterial(options);
    const record={el,material,auto:!!options?._auto,attributePreset:el.getAttribute('data-glass')||'regular',oldClass:el.classList.contains('lg-surface'),oldState:el.getAttribute('data-lg-surface'),oldRadius:el.style.getPropertyValue('--lg-radius'),order:Number.isFinite(options.order)?options.order:0};
    record.radiusOverride=typeof options==='object'&&Object.hasOwn(options,'radius');
    el.classList.add('lg-surface');if(record.radiusOverride)el.style.setProperty('--lg-radius',material.radius+'px');
    record.handle={update:patch=>{
      this._alive();if(!this._surfaces.has(el))throw new Error('Surface was removed');
      const values=patch&&typeof patch==='object'?patch:{};
      record.material=normalizeMaterial(typeof patch==='string'?patch:Object.hasOwn(values,'preset')?values:{...record.material,...values});
      if(Object.hasOwn(values,'radius'))record.radiusOverride=true;
      if(record.radiusOverride)el.style.setProperty('--lg-radius',record.material.radius+'px');
      this._geometryDirty=true;this.invalidate();return record.handle;
    },remove:()=>this.detach(el)};
    this._surfaces.set(el,record);this._resize.observe(el);this._geometryDirty=true;this.invalidate();return record.handle;
  }
  detach(el,{suppressAuto=true}={}) {
    if(this._destroyed)return;
    const s=this._surfaces.get(el);if(!s)return;
    if(s.auto&&suppressAuto)this._removedAuto.add(el);
    this._resize.unobserve(el);
    if(!s.oldClass)el.classList.remove('lg-surface');
    if(s.oldState===null)el.removeAttribute('data-lg-surface');else el.setAttribute('data-lg-surface',s.oldState);
    if(s.oldRadius)el.style.setProperty('--lg-radius',s.oldRadius);else el.style.removeProperty('--lg-radius');
    this._surfaces.delete(el);this._geometryDirty=true;this.invalidate();
  }
  setSource(source,{fit='cover',dynamic}={}) {
    this._alive();
    if(source!==null&&!validSource(source))throw new TypeError('Source must be an image, video, canvas, OffscreenCanvas or ImageBitmap');
    if(!['cover','contain'].includes(fit))throw new TypeError('fit must be cover or contain');
    this._cancelVideo();this._sourceListeners.splice(0).forEach(fn=>fn());
    this._source=source;this._fit=fit;this._dynamic=dynamic??video(source);this._lastVideoTime=-1;this._sourceError=null;this._sourceReady=false;
    this.backdrop.width=this.backdrop.width; // Reset origin-clean status after a tainted source.
    if(source?.addEventListener)for(const event of ['load','loadeddata','seeked','resize','error']){
      const fn=()=>{if(event==='error'){this._sourceError='source-error';this._sourceReady=false;}else{this._sourceError=null;this._sourceDirty=true;}this.invalidate();};
      source.addEventListener(event,fn);this._sourceListeners.push(()=>source.removeEventListener(event,fn));
    }
    this._sourceDirty=true;this._startVideo();this.invalidate();return this;
  }
  _startVideo() {
    if(this._destroyed||document.hidden||!this._inView||!video(this._source)||!this._dynamic||this._videoFrame||typeof this._source.requestVideoFrameCallback!=='function')return;
    this._videoFrame=this._source.requestVideoFrameCallback(()=>{this._videoFrame=0;this._sourceDirty=true;this.invalidate();this._startVideo();});
  }
  _cancelVideo(){if(this._videoFrame&&this._source?.cancelVideoFrameCallback)this._source.cancelVideoFrameCallback(this._videoFrame);this._videoFrame=0;}
  setQuality(quality) {
    this._alive();if(!['auto','low','balanced','high'].includes(quality))throw new TypeError('Unknown quality');
    this.quality=quality;this._effectiveQuality=quality==='auto'?'balanced':quality;this._bufferKey='';this._geometryDirty=true;this.invalidate();return this;
  }
  setMode(mode) {
    this._alive();if(!['auto','css','opaque'].includes(mode))throw new TypeError('Unknown mode');
    this.mode=mode;this._geometryDirty=true;this.invalidate();return this;
  }
  invalidate({source=false}={}) {
    if(this._destroyed)return this;
    if(source){this._sourceDirty=true;this._sourceError=null;}
    this._geometryDirty=true;
    if(!this._frame&&!document.hidden&&this._inView)this._frame=requestAnimationFrame(time=>this._render(time));
    return this;
  }
  trackMotion(milliseconds=350) {
    this._alive();this._motionUntil=Math.max(this._motionUntil,performance.now()+Math.min(10000,Math.max(0,Number(milliseconds)||0)));this.invalidate();return this;
  }
  _measure() {
    // Absolute canvases occupy the root's padding box, not its outer border box.
    // The backdrop uses visibility (rather than display) so it stays measurable.
    const rect=this.backdrop.getBoundingClientRect();
    this._rootRect=rect;this._size={width:Math.max(1,rect.width),height:Math.max(1,rect.height)};
    // A scaled/rotated root cannot keep canvas CSS pixels aligned with client rects.
    const rootStyle=getComputedStyle(this.root);
    // Session Board: 캔버스를 화면에 고정(position: fixed)해서 쓰므로, 보드 상자가 화면 밖으로 나가 생기는 스크롤은 막지 않는다
    this._rootUnsupported=rootStyle.transform!=='none'||!axisAligned(rootStyle)||rootStyle.clipPath!=='none'||rootStyle.maskImage!=='none';
    for(let ancestor=this.root.parentElement;ancestor;ancestor=ancestor.parentElement)if(!axisAligned(getComputedStyle(ancestor))){this._rootUnsupported=true;break;}
    for(const s of this._surfaces.values()){
      const r=s.el.getBoundingClientRect(),style=getComputedStyle(s.el);
      s.rect={x:r.left-rect.left,y:r.top-rect.top,width:r.width,height:r.height};
      s.visible=r.width>0&&r.height>0&&r.bottom>rect.top&&r.top<rect.bottom&&r.right>rect.left&&r.left<rect.right&&style.visibility!=='hidden'&&style.display!=='none';
      s.supported=!this._rootUnsupported&&geometrySupported(s.el,this.root);
      const factor=s.el.offsetWidth?r.width/s.el.offsetWidth:1,limit=Math.min(r.width,r.height)/2;
      const radii=['borderTopLeftRadius','borderTopRightRadius','borderBottomRightRadius','borderBottomLeftRadius'].map(key=>Math.max(0,radius(style[key],Math.min(s.el.offsetWidth,s.el.offsetHeight))*factor));
      const fit=Math.min(1,r.width/(radii[0]+radii[1]||1),r.width/(radii[3]+radii[2]||1),r.height/(radii[0]+radii[3]||1),r.height/(radii[1]+radii[2]||1));
      s.radii=radii.map(value=>value*fit);
      if(s.radii.some(value=>value>limit+.1))s.supported=false;
    }
    this._geometryDirty=false;
  }
  _resizeBuffers() {
    const {width,height}=this._size;
    const settings=QUALITY[this._effectiveQuality];
    const size=computeBufferSize(width,height,{dpr:window.devicePixelRatio||1,...settings,maxSize:this._maxSize||4096});
    const key=size.width+'x'+size.height+':'+this._effectiveQuality;
    if(this._bufferKey===key)return;
    this._bufferKey=key;this.canvas.width=size.width;this.canvas.height=size.height;this.backdrop.width=size.width;this.backdrop.height=size.height;
    this._sourceDirty=true;this._blurDirty=true;
    const gl=this._gl,r=this._resources;if(!gl||!r||this._contextLost)return;
    r.blurWidth=Math.max(1,Math.round(size.width*settings.blurScale));r.blurHeight=Math.max(1,Math.round(size.height*settings.blurScale));
    for(const [tex,fbo] of [[r.ping,r.pingFBO],[r.pong,r.pongFBO]]){
      gl.bindTexture(gl.TEXTURE_2D,tex);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,r.blurWidth,r.blurHeight,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
      gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);
      if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Incomplete framebuffer');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  }
  _paintSource() {
    if(!this._source){this._sourceReady=false;if(this.backdrop.style.visibility!=='hidden')this.backdrop.style.visibility='hidden';this._sourceDirty=false;return;}
    const input=sourceSize(this._source);
    if(input.width<=0||input.height<=0||(video(this._source)&&this._source.readyState<2)){this._sourceReady=false;if(this.backdrop.style.visibility!=='hidden')this.backdrop.style.visibility='hidden';return;}
    try{
      const w=this.backdrop.width,h=this.backdrop.height;
      const rect=fitCover(input.width,input.height,w,h,this._fit);
      this._ctx.fillStyle=this.background;this._ctx.fillRect(0,0,w,h);
      this._ctx.drawImage(this._source,rect.sx,rect.sy,rect.sw,rect.sh,rect.dx,rect.dy,rect.dw,rect.dh);
      if(this.backdrop.style.visibility)this.backdrop.style.visibility='';this._sourceReady=true;this._sourceDirty=false;
      if(video(this._source))this._lastVideoTime=this._source.currentTime;
      const gl=this._gl,r=this._resources;
      if(gl&&r&&!this._contextLost){
        gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,r.scene);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,this.backdrop);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
        this._stats.sourceUploads++;this._blurDirty=true;
      }
    }catch(error){this._sourceError=error.name==='SecurityError'?'source-cors':'source-error';this._sourceDirty=false;this._sourceReady=false;}
  }
  _blur() {
    const gl=this._gl,r=this._resources;
    gl.disable(gl.BLEND);gl.disable(gl.SCISSOR_TEST);gl.useProgram(r.blur);gl.bindVertexArray(r.vao);
    gl.viewport(0,0,r.blurWidth,r.blurHeight);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,r.scene);gl.uniform1i(r.blurUniforms.u_image,0);
    gl.bindFramebuffer(gl.FRAMEBUFFER,r.pingFBO);gl.uniform2f(r.blurUniforms.u_step,5/this._size.width,0);gl.drawArrays(gl.TRIANGLES,0,3);
    gl.bindTexture(gl.TEXTURE_2D,r.ping);gl.bindFramebuffer(gl.FRAMEBUFFER,r.pongFBO);gl.uniform2f(r.blurUniforms.u_step,0,5/this._size.height);gl.drawArrays(gl.TRIANGLES,0,3);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);this._stats.blurPasses+=2;this._blurDirty=false;
  }
  _render(time) {
    this._frame=0;if(this._destroyed||document.hidden||!this._inView)return;
    const begin=performance.now();
    let pointerMoving=false;
    try{
      if(this._geometryDirty||time<this._motionUntil)this._measure();
      this._resizeBuffers();
      if(this._dynamic&&this._source&&!video(this._source))this._sourceDirty=true;
      if(this._dynamic&&video(this._source)&&this._source.currentTime!==this._lastVideoTime)this._sourceDirty=true;
      if(this._sourceDirty)this._paintSource();
      const desired=this._desired();
      if(desired.mode!=='webgl')this._fallback(desired.mode,desired.reason);
      else{
        const gl=this._gl,r=this._resources,p=this._pointer;
        if(this._reducedMotion.matches){p.strength=0;p.targetStrength=0;}
        else{
          for(const [key,target] of [['x','targetX'],['y','targetY'],['strength','targetStrength']]){
            const delta=p[target]-p[key];p[key]+=delta*.22;if(Math.abs(delta)>(key==='strength'?.005:.2))pointerMoving=true;
          }
        }
        if(this._blurDirty)this._blur();
        gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,this.canvas.width,this.canvas.height);
        gl.disable(gl.SCISSOR_TEST);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);gl.useProgram(r.glass);gl.bindVertexArray(r.vao);
        gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,r.scene);gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,r.pong);
        const u=r.uniforms;gl.uniform1i(u.u_scene,0);gl.uniform1i(u.u_blurred,1);gl.uniform2f(u.u_size,this._size.width,this._size.height);
        gl.uniform2f(u.u_pointer,p.x,p.y);gl.uniform1f(u.u_pointerStrength,p.strength);
        gl.enable(gl.SCISSOR_TEST);
        let draws=0;
        const surfaces=[...this._surfaces.values()].sort((a,b)=>a.order-b.order||((a.el.compareDocumentPosition(b.el)&Node.DOCUMENT_POSITION_FOLLOWING)?-1:1));
        for(const s of surfaces){
          if(!s.visible||!s.supported){s.el.setAttribute('data-lg-surface','css');continue;}
          const a=s.rect,m=s.material,sx=this.canvas.width/this._size.width,sy=this.canvas.height/this._size.height;
          const left=Math.max(0,Math.floor((a.x-2)*sx)),bottom=Math.max(0,Math.floor((this._size.height-a.y-a.height-2)*sy));
          const right=Math.min(this.canvas.width,Math.ceil((a.x+a.width+2)*sx)),top=Math.min(this.canvas.height,Math.ceil((this._size.height-a.y+2)*sy));
          gl.scissor(left,bottom,Math.max(0,right-left),Math.max(0,top-bottom));
          gl.uniform4f(u.u_rect,a.x,a.y,a.width,a.height);gl.uniform4fv(u.u_radii,s.radii);
          gl.uniform1f(u.u_bevel,Math.max(1,Math.min(m.bevel,a.width/2,a.height/2)));
          gl.uniform1f(u.u_refraction,m.refraction);gl.uniform1f(u.u_roughness,m.roughness);gl.uniform3fv(u.u_tint,m.tint);
          gl.uniform1f(u.u_tintOpacity,m.tintOpacity);gl.uniform1f(u.u_dispersion,m.dispersion);gl.uniform1f(u.u_highlight,m.highlight);
          gl.drawArrays(gl.TRIANGLES,0,3);draws++;s.el.setAttribute('data-lg-surface','webgl');
        }
        gl.disable(gl.SCISSOR_TEST);if(this.canvas.hidden)this.canvas.hidden=false;this._stats.drawCalls=draws;this._statusChanged('webgl','ready');
      }
      this._stats.frames++;this._stats.submitMs=performance.now()-begin;
    }catch{this._fallback('css','render-error');this._sourceError='render-error';}
    const continuous=this._dynamic&&this._source&&(!video(this._source)||(!this._source.paused&&!this._source.ended&&typeof this._source.requestVideoFrameCallback!=='function'));
    if(pointerMoving||time<this._motionUntil||continuous)this.invalidate();
  }
  destroy() {
    if(this._destroyed)return;
    this._mutation.disconnect();this._cancelVideo();this._sourceListeners.splice(0).forEach(fn=>fn());
    for(const el of [...this._surfaces.keys()])this.detach(el);
    this._destroyed=true;cancelAnimationFrame(this._frame);this._frame=0;
    this._resize.disconnect();this._intersection?.disconnect();this._listeners.splice(0).forEach(fn=>fn());this._disposeGPU();
    this.canvas.remove();this.backdrop.remove();
    if(!this._oldRootClass)this.root.classList.remove('lg-root');
    if(this._oldRootMode===null)this.root.removeAttribute('data-lg-mode');else this.root.setAttribute('data-lg-mode',this._oldRootMode);
    if(this._changedPosition)this.root.style.position=this._oldRootPosition;
    instances.delete(this.root);this._source=null;this._gl=null;
  }
}
export default LiquidGlass;

