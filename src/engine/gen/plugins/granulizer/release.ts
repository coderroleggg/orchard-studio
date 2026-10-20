// The release declick's gains of FL's channel sampler processing: (cos((k + 1) pi / 442) + 1) / 2 for
// k = 0..440 (441 samples at any sample rate), float32. FL computes them with its DSP library's
// cosine, which on macOS is Accelerate's vvcosf (not correctly rounded: 86 of the 441 gains differ
// by one ulp from a correctly rounded cosine); the values were measured against FL's output
// (Fruity Granulizer_x64.dylib 0x1eabe0, test host: 0 differing samples in the declick).
// Stored as float32 bit patterns.

const BITS = [
  '3f7fff2c 3f7ffcb0 3f7ff88d 3f7ff2c2 3f7feb4e 3f7fe234 3f7fd773 3f7fcb0a',
  '3f7fbcfa 3f7fad44 3f7f9be6 3f7f88e2 3f7f7438 3f7f5de8 3f7f45f2 3f7f2c56',
  '3f7f1115 3f7ef430 3f7ed5a7 3f7eb57a 3f7e93a8 3f7e7035 3f7e4b1e 3f7e2466',
  '3f7dfc0b 3f7dd210 3f7da674 3f7d7938 3f7d4a5c 3f7d19e2 3f7ce7ca 3f7cb414',
  '3f7c7ec1 3f7c47d2 3f7c0f48 3f7bd522 3f7b9964 3f7b5c0b 3f7b1d1a 3f7adc92',
  '3f7a9a72 3f7a56be 3f7a1174 3f79ca96 3f798224 3f793820 3f78ec8b 3f789f66',
  '3f7850b0 3f78006e 3f77ae9d 3f775b40 3f770658 3f76afe6 3f7657ec 3f75fe68',
  '3f75a35f 3f7546d0 3f74e8bd 3f748927 3f74280f 3f73c576 3f73615e 3f72fbc8',
  '3f7294b6 3f722c28 3f71c220 3f7156a0 3f70e9a8 3f707b3a 3f700b58 3f6f9a02',
  '3f6f273c 3f6eb306 3f6e3d61 3f6dc64f 3f6d4dd2 3f6cd3ea 3f6c589a 3f6bdbe4',
  '3f6b5dc8 3f6ade4a 3f6a5d69 3f69db28 3f695789 3f68d28d 3f684c36 3f67c485',
  '3f673b7d 3f66b120 3f66256e 3f65986a 3f650a15 3f647a72 3f63e983 3f635748',
  '3f62c3c6 3f622efb 3f6198ec 3f61019a 3f606906 3f5fcf33 3f5f3423 3f5e97d8',
  '3f5dfa54 3f5d5b98 3f5cbba8 3f5c1a84 3f5b7830 3f5ad4ac 3f5a2ffc 3f598a22',
  '3f58e31e 3f583af5 3f5791a7 3f56e738 3f563ba8 3f558efc 3f54e134 3f543253',
  '3f53825c 3f52d14f 3f521f30 3f516c02 3f50b7c6 3f500280 3f4f4c30 3f4e94d9',
  '3f4ddc7e 3f4d2322 3f4c68c6 3f4bad6d 3f4af11a 3f4a33ce 3f49758d 3f48b658',
  '3f47f634 3f473520 3f467321 3f45b038 3f44ec6a 3f4427b6 3f436221 3f429bac',
  '3f41d45c 3f410c32 3f404330 3f3f7959 3f3eaeb1 3f3de338 3f3d16f4 3f3c49e4',
  '3f3b7c0d 3f3aad70 3f39de12 3f390df4 3f383d1a 3f376b84 3f369938 3f35c637',
  '3f34f284 3f341e21 3f334912 3f327359 3f319cfa 3f30c5f5 3f2fee50 3f2f160b',
  '3f2e3d2b 3f2d63b2 3f2c89a2 3f2baeff 3f2ad3cc 3f29f80a 3f291bbe 3f283ee8',
  '3f27618f 3f2683b2 3f25a558 3f24c67e 3f23e72d 3f230764 3f222727 3f214679',
  '3f20655d 3f1f83d5 3f1ea1e6 3f1dbf90 3f1cdcd9 3f1bf9c1 3f1b164e 3f1a3280',
  '3f194e5c 3f1869e4 3f17851b 3f16a004 3f15baa3 3f14d4f9 3f13ef0b 3f1308da',
  '3f12226a 3f113bbe 3f1054da 3f0f6dbf 3f0e8672 3f0d9ef3 3f0cb749 3f0bcf73',
  '3f0ae777 3f09ff57 3f091716 3f082eb6 3f07463c 3f065da8 3f057501 3f048c47',
  '3f03a37f 3f02baa9 3f01d1cc 3f00e8e7 3f000001 3efe2e32 3efc5c6b 3efa8aae',
  '3ef8b906 3ef6e773 3ef51600 3ef344b0 3ef1738b 3eefa295 3eedd1d7 3eec0153',
  '3eea3114 3ee8611a 3ee69171 3ee4c21a 3ee2f31f 3ee12482 3edf564e 3edd8884',
  '3edbbb2e 3ed9ee4d 3ed821ed 3ed6560f 3ed48abd 3ed2bff9 3ed0f5cc 3ecf2c3a',
  '3ecd634a 3ecb9b01 3ec9d367 3ec80c7e 3ec64650 3ec480e0 3ec2bc37 3ec0f856',
  '3ebf3547 3ebd7310 3ebbb1b2 3eb9f13a 3eb831a7 3eb67304 3eb4b552 3eb2f89c',
  '3eb13ce2 3eaf8230 3eadc886 3eac0fee 3eaa586a 3ea8a204 3ea6ecbc 3ea5389e',
  '3ea385aa 3ea1d3eb 3ea02362 3e9e7417 3e9cc60e 3e9b194e 3e996ddc 3e97c3be',
  '3e961af8 3e947393 3e92cd90 3e9128f6 3e8f85cf 3e8de418 3e8c43dc 3e8aa51e',
  '3e8907e9 3e876c3a 3e85d21a 3e84398e 3e82a2a0 3e810d4e 3e7ef340 3e7bcf36',
  '3e78ae92 3e75914e 3e72777c 3e6f6126 3e6c4e5e 3e693f20 3e66337c 3e632b7e',
  '3e602736 3e5d26a0 3e5a29cc 3e5730c6 3e543b9c 3e514a4e 3e4e5ce8 3e4b7378',
  '3e488e0a 3e45ac9e 3e42cf42 3e3ff600 3e3d20e8 3e3a4ff8 3e37833e 3e34bac2',
  '3e31f696 3e2f36b6 3e2c7b30 3e29c40e 3e271160 3e246322 3e21b964 3e1f142c',
  '3e1c738a 3e19d77c 3e174010 3e14ad4e 3e121f44 3e0f95f2 3e0d1162 3e0a919e',
  '3e0816b4 3e05a0a2 3e032f74 3e00c332 3dfcb7d8 3df7f338 3df338a0 3dee8824',
  '3de9e1dc 3de545c0 3de0b3e8 3ddc2c6c 3dd7af5c 3dd33cb4 3dced494 3dca7704',
  '3dc6241c 3dc1dbd8 3dbd9e54 3db96b98 3db543bc 3db126c0 3dad14b8 3da90db0',
  '3da511c0 3da120e4 3d9d3b30 3d9960b0 3d95917c 3d91cd8c 3d8e14fc 3d8a67d4',
  '3d86c624 3d832fec 3d7f4a88 3d784c68 3d716590 3d6a9610 3d63de08 3d5d3d80',
  '3d56b4b0 3d504380 3d49ea20 3d43a8a0 3d3d7f20 3d376d98 3d317430 3d2b9300',
  '3d25ca10 3d201980 3d1a8150 3d1501a0 3d0f9a80 3d0a4c08 3d051638 3cfff260',
  '3cf5e9f0 3cec1360 3ce26eb0 3cd8fc10 3ccfbb90 3cc6ad60 3cbdd190 3cb52850',
  '3cacb1b0 3ca46de0 3c9c5cc0 3c947ea0 3c8cd390 3c855bc0 3c7c2e20 3c6e0b80',
  '3c604fc0 3c52fb20 3c460d80 3c398780 3c2d68e0 3c21b220 3c166320 3c0b7c20',
  '3c00fd40 3bedcd40 3bda7100 3bc7e5c0 3bb62bc0 3ba54340 3b952cc0 3b85e800',
  '3b6eeb00 3b53aa80 3b3a0f00 3b221900 3b0bc880 3aee3d00 3ac83400 3aa57900',
  '3a860b00 3a53d600 3a223600 39ee5c00 39a58c00 3953e800 38ee6000 38540000',
  '37540000',
].join(' ').split(' ');

export const RELEASE_GAINS: Float32Array = (() => {
  const t = new Float32Array(441);
  const u = new Uint32Array(t.buffer);
  for (let i = 0; i < 441; i++) u[i] = parseInt(BITS[i], 16);
  return t;
})();
