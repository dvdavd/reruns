// Renders immersive video onto a canvas: equirectangular or fisheye source,
// stereo layouts, and DeoVR's packed-alpha matte. Both apps need this — VR and
// 180/360 material is not unique to a VR library — and it is the kind of code
// nobody should write twice.
//
// This is a plain class, not a component. It owns a WebGL context and paints a
// texture every frame; there is no markup for a VDOM to diff. The app supplies
// the canvas, the video element, and the source's own description.
//
//   projection  'fisheye' | 'hequirect'   how the source maps to a sphere
//   layout      'sbs' | 'tb' | null       how the two eyes are packed
//   alphaPacked                           a DeoVR matte travels in the frame
//   inputHfov                             the source's horizontal field of view

export const MIN_FOV = 30;
export const MAX_FOV = 120;

const VERTEX = `attribute vec2 p; varying vec2 uv; void main(){uv=p*.5+.5;gl_Position=vec4(p,0.,1.);}`;

const FRAGMENT = `precision mediump float;
varying vec2 uv; uniform sampler2D frame; uniform vec3 accent; uniform vec2 fisheyeScale; uniform float aspect,fov,yaw,pitch,inputFov,alphaGain,alphaStep,alphaInset; uniform int layout,projection,packedAlpha;
float redExcess(vec3 value){return max(0.,value.r-max(value.g,value.b));}
vec2 leftAlphaUv(vec2 eye){
  // A 40%-height mask is split horizontally. Its top half is stored at
  // bottom-centre and its bottom half at top-centre in a 2:1 DeoVR frame.
  float y=eye.y<.5?.8+eye.y*.4:(eye.y-.5)*.4;
  return vec2(.4+eye.x*.2,y);
}
float leftAlpha(vec2 eye){
  return redExcess(texture2D(frame,leftAlphaUv(clamp(eye,0.,1.))).rgb);
}
float featheredLeftAlpha(vec2 eye){
  vec2 x=vec2(alphaStep,0.),y=vec2(0.,alphaStep);
  // A compact cross filter softens encoded matte edges while preserving the
  // reconstructed seam because every offset is mapped independently.
  return (leftAlpha(eye)*4.
    +leftAlpha(eye-x)+leftAlpha(eye+x)+leftAlpha(eye-y)+leftAlpha(eye+y))/8.;
}
__ROOM__
void main(){
  vec2 q=(uv-.5)*2.; q.x*=aspect; float z=1./tan(radians(fov)*.5); vec3 d=normalize(vec3(q.x,-q.y,z));
  float cy=cos(radians(yaw)),sy=sin(radians(yaw)),cp=cos(radians(pitch)),sp=sin(radians(pitch));
  vec3 pitched=vec3(d.x,cp*d.y-sp*d.z,sp*d.y+cp*d.z);
  d=vec3(cy*pitched.x+sy*pitched.z,pitched.y,-sy*pitched.x+cy*pitched.z);
  vec2 s; bool outside=false;
  if(projection==0){float theta=acos(clamp(d.z,-1.,1.)); float radius=theta/radians(inputFov); float len=length(d.xy); s=.5+(len>0.?vec2(d.x,-d.y)/len:vec2(0.))*radius*fisheyeScale; outside=theta>radians(inputFov)*.5;}
  else {s=vec2(.5+atan(d.x,d.z)/3.14159265,.5-asin(clamp(d.y,-1.,1.))/3.14159265); outside=abs(atan(d.x,d.z))>1.5707963;}
  outside=outside||s.x<0.||s.x>1.||s.y<0.||s.y>1.; vec2 eye=s;
  if(layout==1)s.x*=.5; else if(layout==2)s.y*=.5;
  vec4 colour=texture2D(frame,s); float alpha=1.;
  if(packedAlpha==1){
    float matte=clamp(featheredLeftAlpha(eye)*alphaGain,0.,1.);
    alpha=clamp((matte-alphaInset)/(1.-alphaInset),0.,1.);
  }
  if(packedAlpha==1){
    vec3 background=roomScene(d)*1.2;
    gl_FragColor=vec4(mix(background,colour.rgb,outside?0.:alpha),1.);
  }else gl_FragColor=outside?vec4(0.,0.,0.,1.):colour;
}`;

/** Clamps a field of view into the range the view controls allow. */
export const clampFov = value => Math.max(MIN_FOV, Math.min(MAX_FOV, Number(value) || MIN_FOV));

/**
 * How much of one eye the fisheye circle actually fills, as a fraction of the
 * eye's width and height. A fisheye image is round, so it is stored inscribed
 * in a square; when the eye's own rectangle is not square - a top/bottom pair
 * in a 1:1 frame gives each eye a 2:1 half - the circle sits centred with the
 * remainder padded. Mapping the whole rectangle onto the circle instead
 * squeezes the sides inwards and distorts the aspect ratio.
 *
 * Equirectangular sources fill their rectangle by construction, so this
 * applies to fisheye only.
 */
export function fisheyeEyeScale(videoWidth, videoHeight, layout) {
  const width = layout === 'sbs' ? videoWidth / 2 : videoWidth;
  const height = layout === 'tb' ? videoHeight / 2 : videoHeight;
  if (!(width > 0) || !(height > 0)) return [1, 1];
  const side = Math.min(width, height);
  return [side / width, side / height];
}

/** The horizontal field of view a vertical one covers at this aspect ratio. */
export function horizontalFov(verticalFov, aspect) {
  const ratio = aspect > 0 ? aspect : 16 / 9;
  return 2 * Math.atan(ratio * Math.tan(verticalFov * Math.PI / 360)) * 180 / Math.PI;
}

/**
 * Where a drag lands the view. Panning is scaled by the current field of view
 * so a zoomed-in view moves proportionally less per pixel, and pitch stops
 * short of the poles where the projection degenerates.
 */
export function panBy(view, dx, dy) {
  const degreesPerPixel = 0.18 * view.fov / 90;
  return {
    ...view,
    yaw: view.yaw - dx * degreesPerPixel,
    pitch: Math.max(-85, Math.min(85, view.pitch + dy * degreesPerPixel)),
  };
}

/** Where a pinch lands the field of view. */
export function pinchBy(view, deltaDistance) {
  return {...view, fov: clampFov(view.fov - deltaDistance * 0.12)};
}

export class ProjectionRenderer {
  /**
   * `roomShader` paints what surrounds an alpha-packed subject. It is the only
   * part of the projection an app is likely to want its own version of, so it
   * is supplied rather than fixed; the default is a plain dark surround.
   */
  constructor(canvas, video, {roomShader = DEFAULT_ROOM} = {}) {
    this.canvas = canvas;
    this.video = video;
    this.roomShader = roomShader;
    this.gl = null;
    this.program = null;
    this.texture = null;
  }

  /** Compiles the shaders. Returns false when WebGL is unavailable. */
  initialise() {
    // Always request an alpha-capable drawing buffer so switching from an
    // opaque video to packed-alpha content does not require a new canvas.
    const gl = this.canvas.getContext('webgl', {alpha: true, premultipliedAlpha: false});
    if (!gl) return false;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader));
      }
      return shader;
    };
    try {
      const program = gl.createProgram();
      gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER,
        FRAGMENT.replace('__ROOM__', this.roomShader)));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
      gl.useProgram(program);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, 'p');
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      this.gl = gl;
      this.program = program;
      this.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      // HTML video frames have a top-left origin; WebGL texture coordinates
      // have a bottom-left origin. Flip only the upload axis so stereo eye
      // selection and the projection's yaw/pitch math remain unchanged.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Paints one frame. `view` is {yaw, pitch, fov}; `source` describes the
   * media; `accent` is an RGB triple tinting the surround.
   */
  draw({view, source, accent}) {
    const gl = this.gl;
    if (!gl || this.video.readyState < 2) return false;
    const packedAlpha = Boolean(source.alphaPacked);
    // Packed alpha adds several texture reads plus the procedural room. A
    // modest pixel-ratio cap avoids excessive load on high-DPI displays.
    const ratio = Math.min(packedAlpha ? 1.5 : 2, devicePixelRatio || 1);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
    } catch {
      return false;
    }
    const uniform = (name, value) =>
      gl.uniform1f(gl.getUniformLocation(this.program, name), value);
    uniform('aspect', width / height);
    uniform('fov', view.fov);
    uniform('yaw', view.yaw);
    uniform('pitch', view.pitch);
    uniform('inputFov', Number(source.inputHfov || 180));
    uniform('alphaGain', 4);
    // DeoVR reconstructs each mask at 40% of frame height. A two-pixel
    // feather in that mask therefore spans 5/source-height in eye UV space.
    uniform('alphaStep', 5 / Math.max(1, this.video.videoHeight));
    // Remove only the faintest part of the feathered boundary, then
    // renormalize so solid mask regions remain fully opaque.
    uniform('alphaInset', 0.08);
    gl.uniform3fv(gl.getUniformLocation(this.program, 'accent'), accent);
    gl.uniform2fv(gl.getUniformLocation(this.program, 'fisheyeScale'),
      source.projection === 'hequirect'
        ? [1, 1]
        : fisheyeEyeScale(this.video.videoWidth, this.video.videoHeight, source.layout));
    gl.uniform1i(gl.getUniformLocation(this.program, 'layout'), source.layout === 'tb' ? 2 : 1);
    gl.uniform1i(gl.getUniformLocation(this.program, 'projection'),
      source.projection === 'hequirect' ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(this.program, 'packedAlpha'), packedAlpha ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return packedAlpha;
  }
}

// The surround an alpha-packed subject is composited over. Consumers can supply
// a room; the default is a flat wash so the shader still links without one.
export const DEFAULT_ROOM = `vec3 roomScene(vec3 d){return vec3(.025,.028,.04)+accent*.05;}`;
