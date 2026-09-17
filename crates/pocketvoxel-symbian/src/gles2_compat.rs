//! ES2 implementation of the shared iOS renderer's small fixed-function surface.
//! Qt owns the context and depth buffer; the geometry, materials and controls
//! remain the same implementation on both handhelds.
#![allow(non_snake_case, dead_code, static_mut_refs)]
use core::ffi::c_void;
use pocketvoxel_core::math::Mat4;
type GLenum = u32;
type GLuint = u32;
type GLint = i32;
type GLsizei = i32;
type GLfloat = f32;
type GLboolean = u8;
unsafe extern "C" {
    pub fn glBindTexture(target: GLenum, texture: GLuint);
    pub fn glBlendFunc(source: GLenum, destination: GLenum);
    pub fn glClear(mask: u32);
    pub fn glClearColor(red: GLfloat, green: GLfloat, blue: GLfloat, alpha: GLfloat);
    pub fn glClearDepthf(depth: GLfloat);
    pub fn glDeleteTextures(count: GLsizei, textures: *const GLuint);
    pub fn glDepthFunc(function: GLenum);
    pub fn glDepthMask(flag: GLboolean);
    #[link_name = "glDisable"]
    fn raw_glDisable(capability: GLenum);
    #[link_name = "glDrawArrays"]
    fn raw_glDrawArrays(mode: GLenum, first: GLint, count: GLsizei);
    #[link_name = "glDrawElements"]
    fn raw_glDrawElements(mode: GLenum, count: GLsizei, kind: GLenum, indices: *const c_void);
    #[link_name = "glEnable"]
    fn raw_glEnable(capability: GLenum);
    pub fn glGenTextures(count: GLsizei, textures: *mut GLuint);
    pub fn glPixelStorei(parameter: GLenum, value: GLint);
    #[link_name = "glScissor"]
    fn raw_glScissor(x: GLint, y: GLint, width: GLsizei, height: GLsizei);
    pub fn glTexImage2D(
        target: GLenum,
        level: GLint,
        internal: GLint,
        width: GLsizei,
        height: GLsizei,
        border: GLint,
        format: GLenum,
        kind: GLenum,
        pixels: *const c_void,
    );
    pub fn glTexParameteri(target: GLenum, parameter: GLenum, value: GLint);
    #[link_name = "glViewport"]
    fn raw_glViewport(x: GLint, y: GLint, width: GLsizei, height: GLsizei);
}
unsafe extern "C" {
    fn glCreateShader(kind: u32) -> u32;
    fn glShaderSource(shader: u32, count: i32, source: *const *const u8, length: *const i32);
    fn glCompileShader(shader: u32);
    fn glGetShaderiv(shader: u32, param: u32, out: *mut i32);
    fn glDeleteShader(shader: u32);
    fn glCreateProgram() -> u32;
    fn glAttachShader(program: u32, shader: u32);
    fn glBindAttribLocation(program: u32, index: u32, name: *const u8);
    fn glLinkProgram(program: u32);
    fn glGetProgramiv(program: u32, param: u32, out: *mut i32);
    fn glDeleteProgram(program: u32);
    fn glUseProgram(program: u32);
    fn glGetUniformLocation(program: u32, name: *const u8) -> i32;
    fn glUniformMatrix4fv(location: i32, count: i32, transpose: u8, value: *const f32);
    fn glUniform1i(location: i32, value: i32);
    fn glUniform1f(location: i32, value: f32);
    fn glEnableVertexAttribArray(index: u32);
    fn glDisableVertexAttribArray(index: u32);
    fn glVertexAttribPointer(
        index: u32,
        size: i32,
        kind: u32,
        normalized: u8,
        stride: i32,
        pointer: *const c_void,
    );
    fn glBindBuffer(target: u32, buffer: u32);
    fn glActiveTexture(texture: u32);
}
static mut PROGRAM: u32 = 0;
static mut MATRIX: i32 = -1;
static mut TEXTURED: i32 = -1;
static mut ALPHA: i32 = -1;
static mut PROJECTION: Mat4 = Mat4 {
    m: [
        1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
    ],
};
static mut MODEL: Mat4 = Mat4 {
    m: [
        1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
    ],
};
static mut MODE: u32 = 0x1701;
static mut HAS_TEXTURE: bool = false;
static mut HAS_ALPHA: bool = false;
static mut ALPHA_REF: f32 = 0.5;
static mut TARGET: [i32; 4] = [0, 0, 640, 960];

unsafe fn shader(kind: u32, source: &[u8]) -> u32 {
    let shader = glCreateShader(kind);
    let pointer = source.as_ptr();
    let length = source.len() as i32;
    glShaderSource(shader, 1, &pointer, &length);
    glCompileShader(shader);
    let mut ok = 0;
    glGetShaderiv(shader, 0x8b81, &mut ok);
    if ok == 0 {
        glDeleteShader(shader);
        0
    } else {
        shader
    }
}
pub unsafe fn initialize() -> bool {
    if PROGRAM != 0 {
        return true;
    }
    let vs=shader(0x8b31,b"attribute vec3 pos; attribute vec4 color; attribute vec2 uv; uniform mat4 matrix; varying vec4 tint; varying vec2 tex; void main(){gl_Position=matrix*vec4(pos,1.0);tint=color;tex=uv;}");
    let fs=shader(0x8b30,b"precision mediump float; varying vec4 tint; varying vec2 tex; uniform sampler2D image; uniform int textured; uniform float alphaRef; void main(){vec4 c=tint;if(textured!=0)c*=texture2D(image,tex);if(c.a<=alphaRef)discard;gl_FragColor=c;}");
    if vs == 0 || fs == 0 {
        if vs != 0 {
            glDeleteShader(vs)
        }
        if fs != 0 {
            glDeleteShader(fs)
        }
        return false;
    }
    let p = glCreateProgram();
    glAttachShader(p, vs);
    glAttachShader(p, fs);
    glBindAttribLocation(p, 0, b"pos\0".as_ptr());
    glBindAttribLocation(p, 1, b"color\0".as_ptr());
    glBindAttribLocation(p, 2, b"uv\0".as_ptr());
    glLinkProgram(p);
    glDeleteShader(vs);
    glDeleteShader(fs);
    let mut ok = 0;
    glGetProgramiv(p, 0x8b82, &mut ok);
    if ok == 0 {
        glDeleteProgram(p);
        return false;
    }
    PROGRAM = p;
    MATRIX = glGetUniformLocation(p, b"matrix\0".as_ptr());
    TEXTURED = glGetUniformLocation(p, b"textured\0".as_ptr());
    ALPHA = glGetUniformLocation(p, b"alphaRef\0".as_ptr());
    glUseProgram(p);
    glUniform1i(glGetUniformLocation(p, b"image\0".as_ptr()), 0);
    true
}
pub unsafe fn shutdown(live: bool) {
    if live && PROGRAM != 0 {
        glDeleteProgram(PROGRAM);
    }
    PROGRAM = 0;
}
pub unsafe fn target(x: i32, y: i32, w: i32, h: i32) {
    TARGET = [x, y, w, h];
}
unsafe fn prepare() {
    glUseProgram(PROGRAM);
    glActiveTexture(0x84c0);
    let matrix = PROJECTION.mul(&MODEL);
    glUniformMatrix4fv(MATRIX, 1, 0, matrix.m.as_ptr());
    glUniform1i(TEXTURED, i32::from(HAS_TEXTURE));
    glUniform1f(ALPHA, if HAS_ALPHA { ALPHA_REF } else { -1.0 });
    glBindBuffer(0x8893, 0);
}
pub unsafe fn glEnable(cap: u32) {
    match cap {
        0x0de1 => HAS_TEXTURE = true,
        0x0bc0 => HAS_ALPHA = true,
        _ => raw_glEnable(cap),
    }
}
pub unsafe fn glDisable(cap: u32) {
    match cap {
        0x0de1 => HAS_TEXTURE = false,
        0x0bc0 => HAS_ALPHA = false,
        _ => raw_glDisable(cap),
    }
}
pub unsafe fn glAlphaFunc(_function: u32, value: f32) {
    ALPHA_REF = value;
}
pub unsafe fn glMatrixMode(mode: u32) {
    MODE = mode;
}
pub unsafe fn glLoadIdentity() {
    glLoadMatrixf(
        [
            1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
        ]
        .as_ptr(),
    );
}
pub unsafe fn glLoadMatrixf(data: *const f32) {
    let mut m = [0.; 16];
    m.copy_from_slice(core::slice::from_raw_parts(data, 16));
    if MODE == 0x1701 {
        PROJECTION = Mat4 { m };
    } else {
        MODEL = Mat4 { m };
    }
}
pub unsafe fn glOrthof(l: f32, r: f32, b: f32, t: f32, n: f32, f: f32) {
    glLoadMatrixf(
        [
            2. / (r - l),
            0.,
            0.,
            0.,
            0.,
            2. / (t - b),
            0.,
            0.,
            0.,
            0.,
            -2. / (f - n),
            0.,
            -(r + l) / (r - l),
            -(t + b) / (t - b),
            -(f + n) / (f - n),
            1.,
        ]
        .as_ptr(),
    );
}
fn attribute(array: u32) -> u32 {
    match array {
        0x8074 => 0,
        0x8076 => 1,
        _ => 2,
    }
}
pub unsafe fn glEnableClientState(array: u32) {
    glEnableVertexAttribArray(attribute(array));
}
pub unsafe fn glDisableClientState(array: u32) {
    glDisableVertexAttribArray(attribute(array));
}
pub unsafe fn glVertexPointer(size: i32, kind: u32, stride: i32, pointer: *const c_void) {
    glBindBuffer(0x8892, 0);
    glVertexAttribPointer(0, size, kind, 0, stride, pointer);
}
pub unsafe fn glColorPointer(size: i32, kind: u32, stride: i32, pointer: *const c_void) {
    glBindBuffer(0x8892, 0);
    glVertexAttribPointer(1, size, kind, 1, stride, pointer);
}
pub unsafe fn glTexCoordPointer(size: i32, kind: u32, stride: i32, pointer: *const c_void) {
    glBindBuffer(0x8892, 0);
    glVertexAttribPointer(2, size, kind, 0, stride, pointer);
}
pub unsafe fn glDrawArrays(mode: u32, first: i32, count: i32) {
    prepare();
    raw_glDrawArrays(mode, first, count);
}
pub unsafe fn glDrawElements(mode: u32, count: i32, kind: u32, indices: *const c_void) {
    prepare();
    raw_glDrawElements(mode, count, kind, indices);
}
pub unsafe fn glViewport(x: i32, y: i32, w: i32, h: i32) {
    raw_glViewport(
        TARGET[0] + x * TARGET[2] / 640,
        TARGET[1] + y * TARGET[3] / 960,
        w * TARGET[2] / 640,
        h * TARGET[3] / 960,
    );
}
pub unsafe fn glScissor(x: i32, y: i32, w: i32, h: i32) {
    raw_glScissor(
        TARGET[0] + x * TARGET[2] / 640,
        TARGET[1] + y * TARGET[3] / 960,
        w * TARGET[2] / 640,
        h * TARGET[3] / 960,
    );
}
// Qt's extension contract allocates the window's ES2 depth attachment.
pub unsafe fn glGenRenderbuffersOES(_n: i32, name: *mut u32) {
    *name = 1;
}
pub unsafe fn glBindRenderbufferOES(_target: u32, _name: u32) {}
pub unsafe fn glRenderbufferStorageOES(_target: u32, _format: u32, _w: i32, _h: i32) {}
pub unsafe fn glFramebufferRenderbufferOES(_target: u32, _attachment: u32, _kind: u32, _name: u32) {
}
pub unsafe fn glCheckFramebufferStatusOES(_target: u32) -> u32 {
    0x8cd5
}
pub unsafe fn glDeleteRenderbuffersOES(_n: i32, _name: *const u32) {}
