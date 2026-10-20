// The libm routines FL's Slicex calls (libsystem_m: exp, log, sin, cos through the FPC wrappers
// 0x9090 / 0x90b0 / 0x90d0 / 0x90f0, and __sincosf_stret in the pan law 0x44dc), bit-exact ports
// shared read-only from the Harmor and Drumpad engines: V8's Math.* differ in the last bit for a
// few percent of arguments, which flips float roundings in FL's laws.

export { exp, log, sin, cos } from '../harmor/fx-libm';
export { sincosf, sincos } from '../drumpad/libm';
