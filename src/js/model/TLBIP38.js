'use strict';

define(['bitcoinjs-lib', 'bip39', 'crypto-js'],
    function(Bitcoin, BIP39, CryptoJS) {

      // TODO: modified BIP39 package and copy paste base-x decode here. do better way
      var hash256 = Bitcoin.crypto.hash256;
      var BigInteger = Bitcoin.BigInteger;
      var Buffer = Bitcoin.Buffer;
      var assert = BIP39.assert;
      var Unorm = BIP39.unorm;

      function base (ALPHABET) {
        var ALPHABET_MAP = {}
        var BASE = ALPHABET.length
        var LEADER = ALPHABET.charAt(0)

        // pre-compute lookup table
        for (var i = 0; i < ALPHABET.length; i++) {
          ALPHABET_MAP[ALPHABET.charAt(i)] = i
        }

        function decode (string) {
          if (string.length === 0) return []

          var i, j
          var bytes = [0]

          for (i = 0; i < string.length; i++) {
            var c = string[i]
            if (!(c in ALPHABET_MAP)) throw new Error('Non-base' + BASE + ' character')

            for (j = 0; j < bytes.length; j++) bytes[j] *= BASE
            bytes[0] += ALPHABET_MAP[c]

            var carry = 0
            for (j = 0; j < bytes.length; ++j) {
              bytes[j] += carry

              carry = bytes[j] >> 8
              bytes[j] &= 0xff
            }

            while (carry) {
              bytes.push(carry & 0xff)

              carry >>= 8
            }
          }

          // deal with leading zeros
          for (i = 0; string[i] === LEADER && i < string.length - 1; i++) {
            bytes.push(0)
          }

          return bytes.reverse()
        }

        return {
          decode: decode
        }
      }

      var Base58 = base('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz');

      function TLBIP38() {
      }

      function bufferToWordArray(buffer) {
        assert(Buffer.isBuffer(buffer), "Expected Buffer, got", buffer);
        var words = [];
        for (var i = 0, b = 0; i < buffer.length; i++, b += 8) {
          words[b >>> 5] |= buffer[i] << 24 - b % 32;
        }

        return new CryptoJS.lib.WordArray.init(words, buffer.length);
      }

      function wordArrayToBuffer(wordArray) {
        assert(Array.isArray(wordArray.words), "Expected WordArray, got" + wordArray);
        var words = wordArray.words;
        var buffer = new Buffer(words.length * 4);
        words.forEach(function(value, i) {
          buffer.writeInt32BE(value & -1, i * 4);
        });

        return buffer;
      }

      TLBIP38.parseBIP38toECKey = function(base58Encrypted, passPhrase, success, wrongPassword, error) {
        var hex;

        // Unicode NFC normalization
        passPhrase = Unorm.nfc(passPhrase);

        try {
          hex = Base58.decode(base58Encrypted);
        } catch (e) {
          error('Invalid Private Key');
          return;
        }

        if (hex.length != 43) {
          error('Invalid Private Key');
          return;
        } else if (hex[0] != 0x01) {
          error('Invalid Private Key');
          return;
        }

        var expChecksum = hex.slice(-4);
        hex = hex.slice(0, -4);

        var checksum = hash256(hex);

        if (checksum[0] != expChecksum[0] || checksum[1] != expChecksum[1] || checksum[2] != expChecksum[2] || checksum[3] != expChecksum[3]) {
          error('Invalid Private Key');
          return;
        }

        var isCompPoint = false;
        var isECMult = false;
        var hasLotSeq = false;
        if (hex[1] == 0x42) {
          if (hex[2] == 0xe0) {
            isCompPoint = true;
          } else if (hex[2] != 0xc0) {
            error('Invalid Private Key');
            return;
          }
        } else if (hex[1] == 0x43) {
          isECMult = true;
          isCompPoint = (hex[2] & 0x20) != 0;
          hasLotSeq = (hex[2] & 0x04) != 0;
          if ((hex[2] & 0x24) != hex[2]) {
            error('Invalid Private Key');
            return;
          }
        } else {
          error('Invalid Private Key');
          return;
        }

        var decrypted;
        var AES_opts = { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.NoPadding };

        var verifyHashAndReturn = function() {
          var tmpkey = new Bitcoin.ECKey(decrypted, isCompPoint);

          var base58Address = tmpkey.pub.getAddress().toBase58Check();

          checksum = hash256(base58Address);

          if (checksum[0] != hex[3] || checksum[1] != hex[4] || checksum[2] != hex[5] || checksum[3] != hex[6]) {
            wrongPassword();
            return;
          }

          success(tmpkey.toWIF(), isCompPoint);
        };

        if (!isECMult) {
          var addresshash = Buffer(hex.slice(3, 7));

          Crypto_scrypt(passPhrase, addresshash, 16384, 8, 8, 64, function(derivedBytes) {

            var k = bufferToWordArray(derivedBytes.slice(32, 32+32));

            var decryptedWords = CryptoJS.AES.decrypt({ciphertext: bufferToWordArray(Buffer(hex.slice(7, 7+32)))}, k, AES_opts);
            var decryptedBytes = wordArrayToBuffer(decryptedWords);
            for (var x = 0; x < 32; x++) { decryptedBytes[x] ^= derivedBytes[x]; }

            decrypted = BigInteger.fromBuffer(decryptedBytes);

            verifyHashAndReturn();
          });
        } else {
          var ownerentropy = hex.slice(7, 7+8);
          var ownersalt = Buffer(!hasLotSeq ? ownerentropy : ownerentropy.slice(0, 4));

          Crypto_scrypt(passPhrase, ownersalt, 16384, 8, 8, 32, function(prefactorA) {

            var passfactor;

            if (!hasLotSeq) {
              passfactor = prefactorA;
            } else {
              var prefactorB = Buffer.concat([prefactorA, Buffer(ownerentropy)]);
              passfactor = hash256(prefactorB);
            }

            var kp = new Bitcoin.ECKey(BigInteger.fromBuffer(passfactor));

            var passpoint = kp.pub.toBuffer();

            var encryptedpart2 = Buffer(hex.slice(23, 23+16));

            var addresshashplusownerentropy = Buffer(hex.slice(3, 3+12));

            Crypto_scrypt(passpoint, addresshashplusownerentropy, 1024, 1, 1, 64, function(derived) {
              var k = bufferToWordArray(derived.slice(32));

              var unencryptedpart2 = CryptoJS.AES.decrypt({ciphertext: bufferToWordArray(encryptedpart2)}, k, AES_opts);

              var unencryptedpart2Bytes = wordArrayToBuffer(unencryptedpart2);

              for (var i = 0; i < 16; i++) { unencryptedpart2Bytes[i] ^= derived[i+16]; }

              var encryptedpart1 = Buffer.concat([Buffer(hex.slice(15, 15+8)), Buffer(unencryptedpart2Bytes.slice(0, 0+8))]);

              var unencryptedpart1 = CryptoJS.AES.decrypt({ciphertext: bufferToWordArray(encryptedpart1)}, k, AES_opts);

              var unencryptedpart1Bytes = wordArrayToBuffer(unencryptedpart1);

              for (var i = 0; i < 16; i++) { unencryptedpart1Bytes[i] ^= derived[i]; }

              var seedb = Buffer.concat([Buffer(unencryptedpart1Bytes.slice(0, 0+16)), Buffer(unencryptedpart2Bytes.slice(8, 8+8))]);

              var factorb = hash256(seedb);

              // secp256k1: N
              var N = BigInteger.fromHex('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

              decrypted = BigInteger.fromBuffer(passfactor).multiply(BigInteger.fromBuffer(factorb)).remainder(N);

              verifyHashAndReturn();
            });
          });
        }
      };


      var MAX_VALUE = 2147483647;
      var workerUrl = null;

      function Crypto_scrypt(passwd, salt, N, r, p, dkLen, callback) {
        if (N == 0 || (N & (N - 1)) != 0) throw Error("N must be > 0 and a power of 2");

        if (N > MAX_VALUE / 128 / r) throw Error("Parameter N is too large");
        if (r > MAX_VALUE / 128 / p) throw Error("Parameter r is too large");

        if(typeof(passwd) !== 'string') {
          passwd = bufferToWordArray(passwd);
        }

        if(typeof(salt) !== 'string') {
          salt = bufferToWordArray(salt);
        }

        var PBKDF2_opts = {iterations: 1, keySize: dkLen/4, hasher: CryptoJS.algo.SHA256};

        var B = CryptoJS.PBKDF2(passwd, salt, { iterations: 1, keySize: (p * 128 * r)/4, hasher: CryptoJS.algo.SHA256});

        B = wordArrayToBuffer(B);

        // There is a bug in the web worker below, so it's not used currently.

        // try {
        //     var i = 0;
        //     var worksDone = 0;
        //     var makeWorker = function() {
        //         if (!workerUrl) {
        //             var code = '('+scryptCore.toString()+')()';
        //             var blob;
        //             try {
        //                 blob = new Blob([code], {type: "text/javascript"});
        //             } catch(e) {
        //                 window.BlobBuilder = window.BlobBuilder || window.WebKitBlobBuilder || window.MozBlobBuilder || window.MSBlobBuilder;
        //                 blob = new BlobBuilder();
        //                 blob.append(code);
        //                 blob = blob.getBlob("text/javascript");
        //             }
        //             workerUrl = URL.createObjectURL(blob);
        //         }
        //         var worker = new Worker(workerUrl);
        //         worker.onmessage = function(event) {
        //             var Bi = event.data[0], Bslice = event.data[1];
        //             worksDone++;
        //
        //             if (i < p) {
        //                 worker.postMessage([N, r, p, B, i++]);
        //             }
        //
        //             var length = Bslice.length, destPos = Bi * 128 * r, srcPos = 0;
        //             while (length--) {
        //                 B[destPos++] = Bslice[srcPos++];
        //             }
        //
        //             if (worksDone == p) {
        //                 B = Buffer(B);
        //                 B = bufferToWordArray(B);
        //
        //                 var ret = wordArrayToBuffer(CryptoJS.PBKDF2(passwd, B, PBKDF2_opts));
        //                 callback(ret);
        //             }
        //         };
        //         return worker;
        //     };
        //     var workers = [makeWorker()];
        //     workers[0].postMessage([N, r, p, B, i++]);
        //     if (p > 1) {
        //         workers[1].postMessage([N, r, p, B, i++]);
        //     }
        // } catch (e) {
        // Called in Firefox and IE which don't support Blob web workers with CSP enabled.
        window.setTimeout(function() {
          scryptCore();
          B = bufferToWordArray(B);
          var ret = wordArrayToBuffer(CryptoJS.PBKDF2(passwd, B, PBKDF2_opts));

          callback(ret);
        }, 0);
        // }

        // using this function to enclose everything needed to create a worker (but also invokable directly for synchronous use)
        function scryptCore() {
          var XY = [], V = [];

          if (typeof B === 'undefined') {
            onmessage = function(event) {
              var data = event.data;
              var N = data[0], r = data[1], p = data[2], B = data[3], i = data[4];

              var Bslice = [];
              arraycopy32(B, i * 128 * r, Bslice, 0, 128 * r);
              smix(Bslice, 0, r, N, V, XY);

              postMessage([i, Bslice]);
            };
          } else {
            for(var i = 0; i < p; i++) {
              smix(B, i * 128 * r, r, N, V, XY);
            }
          }

          function smix(B, Bi, r, N, V, XY) {
            var Xi = 0;
            var Yi = 128 * r;
            var i;

            arraycopy32(B, Bi, XY, Xi, Yi);

            for (i = 0; i < N; i++) {
              arraycopy32(XY, Xi, V, i * Yi, Yi);
              blockmix_salsa8(XY, Xi, Yi, r);
            }

            for (i = 0; i < N; i++) {
              var j = integerify(XY, Xi, r) & (N - 1);
              blockxor(V, j * Yi, XY, Xi, Yi);
              blockmix_salsa8(XY, Xi, Yi, r);
            }

            arraycopy32(XY, Xi, B, Bi, Yi);
          }

          function blockmix_salsa8(BY, Bi, Yi, r) {
            var X = [];
            var i;

            arraycopy32(BY, Bi + (2 * r - 1) * 64, X, 0, 64);

            for (i = 0; i < 2 * r; i++) {
              blockxor(BY, i * 64, X, 0, 64);
              salsa20_8(X);
              arraycopy32(X, 0, BY, Yi + (i * 64), 64);
            }

            for (i = 0; i < r; i++) {
              arraycopy32(BY, Yi + (i * 2) * 64, BY, Bi + (i * 64), 64);
            }

            for (i = 0; i < r; i++) {
              arraycopy32(BY, Yi + (i * 2 + 1) * 64, BY, Bi + (i + r) * 64, 64);
            }
          }

          function R(a, b) {
            return (a << b) | (a >>> (32 - b));
          }

          function salsa20_8(B) {
            var B32 = new Array(32);
            var x   = new Array(32);
            var i;

            for (i = 0; i < 16; i++) {
              B32[i]  = (B[i * 4 + 0] & 0xff) << 0;
              B32[i] |= (B[i * 4 + 1] & 0xff) << 8;
              B32[i] |= (B[i * 4 + 2] & 0xff) << 16;
              B32[i] |= (B[i * 4 + 3] & 0xff) << 24;
            }

            arraycopy(B32, 0, x, 0, 16);

            for (i = 8; i > 0; i -= 2) {
              x[ 4] ^= R(x[ 0]+x[12], 7);  x[ 8] ^= R(x[ 4]+x[ 0], 9);
              x[12] ^= R(x[ 8]+x[ 4],13);  x[ 0] ^= R(x[12]+x[ 8],18);
              x[ 9] ^= R(x[ 5]+x[ 1], 7);  x[13] ^= R(x[ 9]+x[ 5], 9);
              x[ 1] ^= R(x[13]+x[ 9],13);  x[ 5] ^= R(x[ 1]+x[13],18);
              x[14] ^= R(x[10]+x[ 6], 7);  x[ 2] ^= R(x[14]+x[10], 9);
              x[ 6] ^= R(x[ 2]+x[14],13);  x[10] ^= R(x[ 6]+x[ 2],18);
              x[ 3] ^= R(x[15]+x[11], 7);  x[ 7] ^= R(x[ 3]+x[15], 9);
              x[11] ^= R(x[ 7]+x[ 3],13);  x[15] ^= R(x[11]+x[ 7],18);
              x[ 1] ^= R(x[ 0]+x[ 3], 7);  x[ 2] ^= R(x[ 1]+x[ 0], 9);
              x[ 3] ^= R(x[ 2]+x[ 1],13);  x[ 0] ^= R(x[ 3]+x[ 2],18);
              x[ 6] ^= R(x[ 5]+x[ 4], 7);  x[ 7] ^= R(x[ 6]+x[ 5], 9);
              x[ 4] ^= R(x[ 7]+x[ 6],13);  x[ 5] ^= R(x[ 4]+x[ 7],18);
              x[11] ^= R(x[10]+x[ 9], 7);  x[ 8] ^= R(x[11]+x[10], 9);
              x[ 9] ^= R(x[ 8]+x[11],13);  x[10] ^= R(x[ 9]+x[ 8],18);
              x[12] ^= R(x[15]+x[14], 7);  x[13] ^= R(x[12]+x[15], 9);
              x[14] ^= R(x[13]+x[12],13);  x[15] ^= R(x[14]+x[13],18);
            }

            for (i = 0; i < 16; ++i) B32[i] = x[i] + B32[i];

            for (i = 0; i < 16; i++) {
              var bi = i * 4;
              B[bi + 0] = (B32[i] >> 0  & 0xff);
              B[bi + 1] = (B32[i] >> 8  & 0xff);
              B[bi + 2] = (B32[i] >> 16 & 0xff);
              B[bi + 3] = (B32[i] >> 24 & 0xff);
            }
          }

          function blockxor(S, Si, D, Di, len) {
            var i = len>>6;
            while (i--) {
              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];
              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];
              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];
              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];

              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];
              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];
              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];
              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];

              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];
              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];
              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];
              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];

              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];
              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];
              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];
              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];

              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];
              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];
              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];
              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];

              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];
              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];
              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];
              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];

              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];
              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];
              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];
              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];

              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];
              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];
              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];
              D[Di++] ^= S[Si++]; D[Di++] ^= S[Si++];
            }
          }

          function integerify(B, bi, r) {
            var n;

            bi += (2 * r - 1) * 64;

            n  = (B[bi + 0] & 0xff) << 0;
            n |= (B[bi + 1] & 0xff) << 8;
            n |= (B[bi + 2] & 0xff) << 16;
            n |= (B[bi + 3] & 0xff) << 24;

            return n;
          }

          function arraycopy(src, srcPos, dest, destPos, length) {
            while (length-- ){
              dest[destPos++] = src[srcPos++];
            }
          }

          function arraycopy32(src, srcPos, dest, destPos, length) {
            var i = length>>5;
            while(i--) {
              dest[destPos++] = src[srcPos++]; dest[destPos++] = src[srcPos++];
              dest[destPos++] = src[srcPos++]; dest[destPos++] = src[srcPos++];
              dest[destPos++] = src[srcPos++]; dest[destPos++] = src[srcPos++];
              dest[destPos++] = src[srcPos++]; dest[destPos++] = src[srcPos++];

              dest[destPos++] = src[srcPos++]; dest[destPos++] = src[srcPos++];
              dest[destPos++] = src[srcPos++]; dest[destPos++] = src[srcPos++];
              dest[destPos++] = src[srcPos++]; dest[destPos++] = src[srcPos++];
              dest[destPos++] = src[srcPos++]; dest[destPos++] = src[srcPos++];

              dest[destPos++] = src[srcPos++]; dest[destPos++] = src[srcPos++];
              dest[destPos++] = src[srcPos++]; dest[destPos++] = src[srcPos++];
              dest[destPos++] = src[srcPos++]; dest[destPos++] = src[srcPos++];
              dest[destPos++] = src[srcPos++]; dest[destPos++] = src[srcPos++];

              dest[destPos++] = src[srcPos++]; dest[destPos++] = src[srcPos++];
              dest[destPos++] = src[srcPos++]; dest[destPos++] = src[srcPos++];
              dest[destPos++] = src[srcPos++]; dest[destPos++] = src[srcPos++];
              dest[destPos++] = src[srcPos++]; dest[destPos++] = src[srcPos++];
            }
          }
        } // scryptCore
      };

      return TLBIP38;
    });
