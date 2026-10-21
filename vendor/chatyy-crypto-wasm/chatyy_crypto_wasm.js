let wasm_bindgen = (function(exports) {
    let script_src;
    if (typeof document !== 'undefined' && document.currentScript !== null) {
        script_src = new URL(document.currentScript.src, location.href).toString();
    }

    /**
     * A machine-readable representation of the authenticity for a `ShieldState`.
     * @enum {0 | 1 | 2 | 3 | 4 | 5}
     */
    const ShieldStateCode = Object.freeze({
        /**
         * Not enough information available to check the authenticity.
         */
        AuthenticityNotGuaranteed: 0, "0": "AuthenticityNotGuaranteed",
        /**
         * The sending device isn't yet known by the Client.
         */
        UnknownDevice: 1, "1": "UnknownDevice",
        /**
         * The sending device hasn't been verified by the sender.
         */
        UnsignedDevice: 2, "2": "UnsignedDevice",
        /**
         * The sender hasn't been verified by the Client's user.
         */
        UnverifiedIdentity: 3, "3": "UnverifiedIdentity",
        /**
         * The sender was previously verified but changed their identity.
         */
        VerificationViolation: 4, "4": "VerificationViolation",
        /**
         * The `sender` field on the event does not match the owner of the device
         * that established the Megolm session.
         */
        MismatchedSender: 5, "5": "MismatchedSender",
    });
    exports.ShieldStateCode = ShieldStateCode;

    class WasmCore {
        static __wrap(ptr) {
            const obj = Object.create(WasmCore.prototype);
            obj.__wbg_ptr = ptr;
            WasmCoreFinalization.register(obj, obj.__wbg_ptr, obj);
            return obj;
        }
        __destroy_into_raw() {
            const ptr = this.__wbg_ptr;
            this.__wbg_ptr = 0;
            WasmCoreFinalization.unregister(this);
            return ptr;
        }
        free() {
            const ptr = this.__destroy_into_raw();
            wasm.__wbg_wasmcore_free(ptr, 0);
        }
        /**
         * @returns {Promise<any>}
         */
        backupDisable() {
            const ret = wasm.wasmcore_backupDisable(this.__wbg_ptr);
            return takeObject(ret);
        }
        /**
         * @param {string} passphrase
         * @returns {Promise<any>}
         */
        backupEnable(passphrase) {
            const ptr0 = passStringToWasm0(passphrase, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.wasmcore_backupEnable(this.__wbg_ptr, ptr0, len0);
            return takeObject(ret);
        }
        /**
         * @param {string} key_or_passphrase
         * @returns {Promise<any>}
         */
        backupRestore(key_or_passphrase) {
            const ptr0 = passStringToWasm0(key_or_passphrase, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.wasmcore_backupRestore(this.__wbg_ptr, ptr0, len0);
            return takeObject(ret);
        }
        /**
         * @returns {Promise<any>}
         */
        backupStatus() {
            const ret = wasm.wasmcore_backupStatus(this.__wbg_ptr);
            return takeObject(ret);
        }
        /**
         * @param {number} max_batches
         * @returns {Promise<any>}
         */
        backupStep(max_batches) {
            const ret = wasm.wasmcore_backupStep(this.__wbg_ptr, max_batches);
            return takeObject(ret);
        }
        /**
         * @returns {Promise<any>}
         */
        bootstrapIdentity() {
            const ret = wasm.wasmcore_bootstrapIdentity(this.__wbg_ptr);
            return takeObject(ret);
        }
        /**
         * `input_json` = `{convId, envelopeJson, senderUid, serverMid, cmid, tsMs}`.
         * @param {string} input_json
         * @returns {Promise<any>}
         */
        decrypt(input_json) {
            const ptr0 = passStringToWasm0(input_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.wasmcore_decrypt(this.__wbg_ptr, ptr0, len0);
            return takeObject(ret);
        }
        /**
         * @returns {string}
         */
        deviceId() {
            let deferred1_0;
            let deferred1_1;
            try {
                const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
                wasm.wasmcore_deviceId(retptr, this.__wbg_ptr);
                var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
                var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
                deferred1_0 = r0;
                deferred1_1 = r1;
                return getStringFromWasm0(r0, r1);
            } finally {
                wasm.__wbindgen_add_to_stack_pointer(16);
                wasm.__wbindgen_export5(deferred1_0, deferred1_1, 1);
            }
        }
        /**
         * @param {string} conv_id
         * @param {string} member_uids_json
         * @param {string} payload_json
         * @returns {Promise<any>}
         */
        encrypt(conv_id, member_uids_json, payload_json) {
            const ptr0 = passStringToWasm0(conv_id, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(member_uids_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passStringToWasm0(payload_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len2 = WASM_VECTOR_LEN;
            const ret = wasm.wasmcore_encrypt(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
            return takeObject(ret);
        }
        /**
         * @param {string} passphrase
         * @returns {Promise<any>}
         */
        exportRoomKeysWithPassphrase(passphrase) {
            const ptr0 = passStringToWasm0(passphrase, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.wasmcore_exportRoomKeysWithPassphrase(this.__wbg_ptr, ptr0, len0);
            return takeObject(ret);
        }
        /**
         * Resolve com `Uint8Array` (SEGREDO: nunca logar/persistir em claro).
         * @param {string} filter_json
         * @returns {Promise<any>}
         */
        exportRoomKeys(filter_json) {
            const ptr0 = passStringToWasm0(filter_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.wasmcore_exportRoomKeys(this.__wbg_ptr, ptr0, len0);
            return takeObject(ret);
        }
        /**
         * @returns {Promise<any>}
         */
        flushMetrics() {
            const ret = wasm.wasmcore_flushMetrics(this.__wbg_ptr);
            return takeObject(ret);
        }
        /**
         * @param {string} device_id
         * @returns {Promise<any>}
         */
        forgetDevice(device_id) {
            const ptr0 = passStringToWasm0(device_id, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.wasmcore_forgetDevice(this.__wbg_ptr, ptr0, len0);
            return takeObject(ret);
        }
        /**
         * Transporte em uso (o vínculo web reaproveita o mesmo `fetch`).
         * @returns {boolean}
         */
        hasTransport() {
            const ret = wasm.wasmcore_hasTransport(this.__wbg_ptr);
            return ret !== 0;
        }
        /**
         * @param {string} uid
         * @returns {Promise<any>}
         */
        identityStatus(uid) {
            const ptr0 = passStringToWasm0(uid, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.wasmcore_identityStatus(this.__wbg_ptr, ptr0, len0);
            return takeObject(ret);
        }
        /**
         * @param {string} data
         * @param {string} passphrase
         * @returns {Promise<any>}
         */
        importRoomKeysWithPassphrase(data, passphrase) {
            const ptr0 = passStringToWasm0(data, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.wasmcore_importRoomKeysWithPassphrase(this.__wbg_ptr, ptr0, len0, ptr1, len1);
            return takeObject(ret);
        }
        /**
         * @param {Uint8Array} blob
         * @returns {Promise<any>}
         */
        importRoomKeys(blob) {
            const ptr0 = passArray8ToWasm0(blob, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.wasmcore_importRoomKeys(this.__wbg_ptr, ptr0, len0);
            return takeObject(ret);
        }
        /**
         * @param {WasmLinkWeb} link
         * @returns {Promise<any>}
         */
        linkCompleteUpload(link) {
            _assertClass(link, WasmLinkWeb);
            const ret = wasm.wasmcore_linkCompleteUpload(this.__wbg_ptr, link.__wbg_ptr);
            return takeObject(ret);
        }
        /**
         * @param {WasmLinkWeb} link
         * @returns {Promise<any>}
         */
        linkPoll(link) {
            _assertClass(link, WasmLinkWeb);
            const ret = wasm.wasmcore_linkPoll(this.__wbg_ptr, link.__wbg_ptr);
            return takeObject(ret);
        }
        /**
         * O `LinkWeb` não precisa de core até o `Hello`; mas o worker só cria core depois de saber
         * o uid, então expomos o vínculo como objeto separado (`linkWebBegin`).
         * @param {WasmLinkWeb} link
         * @returns {Promise<any>}
         */
        linkSendDevice(link) {
            _assertClass(link, WasmLinkWeb);
            const ret = wasm.wasmcore_linkSendDevice(this.__wbg_ptr, link.__wbg_ptr);
            return takeObject(ret);
        }
        /**
         * @param {string} uid
         * @returns {Promise<any>}
         */
        listDevices(uid) {
            const ptr0 = passStringToWasm0(uid, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.wasmcore_listDevices(this.__wbg_ptr, ptr0, len0);
            return takeObject(ret);
        }
        /**
         * @param {string} uid
         * @returns {Promise<any>}
         */
        markVerified(uid) {
            const ptr0 = passStringToWasm0(uid, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.wasmcore_markVerified(this.__wbg_ptr, ptr0, len0);
            return takeObject(ret);
        }
        /**
         * @returns {string}
         */
        metricsSnapshot() {
            let deferred1_0;
            let deferred1_1;
            try {
                const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
                wasm.wasmcore_metricsSnapshot(retptr, this.__wbg_ptr);
                var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
                var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
                deferred1_0 = r0;
                deferred1_1 = r1;
                return getStringFromWasm0(r0, r1);
            } finally {
                wasm.__wbindgen_add_to_stack_pointer(16);
                wasm.__wbindgen_export5(deferred1_0, deferred1_1, 1);
            }
        }
        /**
         * @param {string} conv_id
         * @param {string} member_uids_json
         * @param {string} removed_uids_json
         * @returns {Promise<any>}
         */
        onMembersChanged(conv_id, member_uids_json, removed_uids_json) {
            const ptr0 = passStringToWasm0(conv_id, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(member_uids_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passStringToWasm0(removed_uids_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len2 = WASM_VECTOR_LEN;
            const ret = wasm.wasmcore_onMembersChanged(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
            return takeObject(ret);
        }
        /**
         * @param {string} uid
         * @returns {Promise<any>}
         */
        pinIdentity(uid) {
            const ptr0 = passStringToWasm0(uid, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.wasmcore_pinIdentity(this.__wbg_ptr, ptr0, len0);
            return takeObject(ret);
        }
        /**
         * @param {string} conv_id
         * @returns {Promise<any>}
         */
        rotateConversation(conv_id) {
            const ptr0 = passStringToWasm0(conv_id, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.wasmcore_rotateConversation(this.__wbg_ptr, ptr0, len0);
            return takeObject(ret);
        }
        /**
         * @param {string} uid
         * @returns {Promise<any>}
         */
        safetyNumber(uid) {
            const ptr0 = passStringToWasm0(uid, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.wasmcore_safetyNumber(this.__wbg_ptr, ptr0, len0);
            return takeObject(ret);
        }
        /**
         * `targets_json` = `[{uid, deviceId}]` (deviceId vazio = todos os assinados).
         * @param {string} event_type
         * @param {string} targets_json
         * @param {string} content_json
         * @returns {Promise<any>}
         */
        sendToDevice(event_type, targets_json, content_json) {
            const ptr0 = passStringToWasm0(event_type, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(targets_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passStringToWasm0(content_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len2 = WASM_VECTOR_LEN;
            const ret = wasm.wasmcore_sendToDevice(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
            return takeObject(ret);
        }
        /**
         * @param {string} device_id
         * @param {string} expected_ed25519
         * @returns {Promise<any>}
         */
        signDevice(device_id, expected_ed25519) {
            const ptr0 = passStringToWasm0(device_id, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(expected_ed25519, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.wasmcore_signDevice(this.__wbg_ptr, ptr0, len0, ptr1, len1);
            return takeObject(ret);
        }
        /**
         * @param {string} sync_data_json
         * @returns {Promise<any>}
         */
        syncWith(sync_data_json) {
            const ptr0 = passStringToWasm0(sync_data_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.wasmcore_syncWith(this.__wbg_ptr, ptr0, len0);
            return takeObject(ret);
        }
        /**
         * @returns {Promise<any>}
         */
        sync() {
            const ret = wasm.wasmcore_sync(this.__wbg_ptr);
            return takeObject(ret);
        }
        /**
         * @returns {Promise<any>}
         */
        thisDevice() {
            const ret = wasm.wasmcore_thisDevice(this.__wbg_ptr);
            return takeObject(ret);
        }
        /**
         * `uids_json` = `["7","42"]`.
         * @param {string} uids_json
         * @returns {Promise<any>}
         */
        trackUsers(uids_json) {
            const ptr0 = passStringToWasm0(uids_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.wasmcore_trackUsers(this.__wbg_ptr, ptr0, len0);
            return takeObject(ret);
        }
        /**
         * @returns {string}
         */
        uid() {
            let deferred1_0;
            let deferred1_1;
            try {
                const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
                wasm.wasmcore_uid(retptr, this.__wbg_ptr);
                var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
                var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
                deferred1_0 = r0;
                deferred1_1 = r1;
                return getStringFromWasm0(r0, r1);
            } finally {
                wasm.__wbindgen_add_to_stack_pointer(16);
                wasm.__wbindgen_export5(deferred1_0, deferred1_1, 1);
            }
        }
        /**
         * @param {string} uid
         * @param {string} scanned
         * @returns {Promise<any>}
         */
        verifySafetyQr(uid, scanned) {
            const ptr0 = passStringToWasm0(uid, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(scanned, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.wasmcore_verifySafetyQr(this.__wbg_ptr, ptr0, len0, ptr1, len1);
            return takeObject(ret);
        }
    }
    if (Symbol.dispose) WasmCore.prototype[Symbol.dispose] = WasmCore.prototype.free;
    exports.WasmCore = WasmCore;

    class WasmLinkWeb {
        static __wrap(ptr) {
            const obj = Object.create(WasmLinkWeb.prototype);
            obj.__wbg_ptr = ptr;
            WasmLinkWebFinalization.register(obj, obj.__wbg_ptr, obj);
            return obj;
        }
        __destroy_into_raw() {
            const ptr = this.__wbg_ptr;
            this.__wbg_ptr = 0;
            WasmLinkWebFinalization.unregister(this);
            return ptr;
        }
        free() {
            const ptr = this.__destroy_into_raw();
            wasm.__wbg_wasmlinkweb_free(ptr, 0);
        }
        /**
         * @returns {string}
         */
        linkId() {
            let deferred1_0;
            let deferred1_1;
            try {
                const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
                wasm.wasmlinkweb_linkId(retptr, this.__wbg_ptr);
                var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
                var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
                deferred1_0 = r0;
                deferred1_1 = r1;
                return getStringFromWasm0(r0, r1);
            } finally {
                wasm.__wbindgen_add_to_stack_pointer(16);
                wasm.__wbindgen_export5(deferred1_0, deferred1_1, 1);
            }
        }
        /**
         * Poll ANTES de existir core (até o `Hello`).
         * @returns {Promise<any>}
         */
        pollNoCore() {
            const ret = wasm.wasmlinkweb_pollNoCore(this.__wbg_ptr);
            return takeObject(ret);
        }
        /**
         * Conteúdo do QR (SEGREDO de 32 B dentro: só para desenhar o QR, nunca logar).
         * @returns {string}
         */
        qrPayload() {
            let deferred1_0;
            let deferred1_1;
            try {
                const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
                wasm.wasmlinkweb_qrPayload(retptr, this.__wbg_ptr);
                var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
                var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
                deferred1_0 = r0;
                deferred1_1 = r1;
                return getStringFromWasm0(r0, r1);
            } finally {
                wasm.__wbindgen_add_to_stack_pointer(16);
                wasm.__wbindgen_export5(deferred1_0, deferred1_1, 1);
            }
        }
    }
    if (Symbol.dispose) WasmLinkWeb.prototype[Symbol.dispose] = WasmLinkWeb.prototype.free;
    exports.WasmLinkWeb = WasmLinkWeb;

    /**
     * @returns {string}
     */
    function coreVersion() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.coreVersion(retptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export5(deferred1_0, deferred1_1, 1);
        }
    }
    exports.coreVersion = coreVersion;

    /**
     * @param {Uint8Array} data
     * @param {string} info_json
     * @returns {Uint8Array}
     */
    function decryptBytes(data, info_json) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(info_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            wasm.decryptBytes(retptr, ptr0, len0, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v3 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export5(r0, r1 * 1, 1);
            return v3;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    exports.decryptBytes = decryptBytes;

    /**
     * Devolve `{info_json}` em JSON; os bytes cifrados ficam em `out` via `encryptBytesData`.
     * Para evitar cópia dupla, a API é: `encryptBytes(plain) -> [Uint8Array data, infoJson]`.
     * @param {Uint8Array} plain
     * @returns {Array<any>}
     */
    function encryptBytes(plain) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(plain, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.encryptBytes(retptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    exports.encryptBytes = encryptBytes;

    /**
     * `-1` = não é envelope `{"e2e":N}`; senão N.
     * @param {string} content
     * @returns {number}
     */
    function envelopeVersion(content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.envelopeVersion(ptr0, len0);
        return ret;
    }
    exports.envelopeVersion = envelopeVersion;

    /**
     * @param {Function} transport_fn
     * @returns {Promise<any>}
     */
    function linkWebBegin(transport_fn) {
        const ret = wasm.linkWebBegin(addHeapObject(transport_fn));
        return takeObject(ret);
    }
    exports.linkWebBegin = linkWebBegin;

    /**
     * @param {string} prefix
     * @returns {string}
     */
    function newDeviceId(prefix) {
        let deferred3_0;
        let deferred3_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(prefix, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.newDeviceId(retptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            var ptr2 = r0;
            var len2 = r1;
            if (r3) {
                ptr2 = 0; len2 = 0;
                throw takeObject(r2);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export5(deferred3_0, deferred3_1, 1);
        }
    }
    exports.newDeviceId = newDeviceId;

    /**
     * Abre o store IndexedDB `store_name` (`chatyy-e2ee5-<uid>`) com a senha derivada no worker.
     * Sem rede. Resolve com um `WasmCore`.
     * @param {string} store_name
     * @param {string} store_passphrase
     * @param {string} uid
     * @param {string} device_id
     * @param {string} holder_suffix
     * @param {Function} transport_fn
     * @returns {Promise<any>}
     */
    function openCore(store_name, store_passphrase, uid, device_id, holder_suffix, transport_fn) {
        const ptr0 = passStringToWasm0(store_name, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(store_passphrase, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(uid, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(device_id, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(holder_suffix, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len4 = WASM_VECTOR_LEN;
        const ret = wasm.openCore(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, addHeapObject(transport_fn));
        return takeObject(ret);
    }
    exports.openCore = openCore;

    /**
     * `msk_a`/`msk_b` em bytes crus (32 B). Devolve JSON `{digits, qrPayload}`.
     * @param {string} uid_a
     * @param {Uint8Array} msk_a
     * @param {string} uid_b
     * @param {Uint8Array} msk_b
     * @returns {string}
     */
    function safetyNumberFor(uid_a, msk_a, uid_b, msk_b) {
        let deferred5_0;
        let deferred5_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(uid_a, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray8ToWasm0(msk_a, wasm.__wbindgen_export);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passStringToWasm0(uid_b, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len2 = WASM_VECTOR_LEN;
            const ptr3 = passArray8ToWasm0(msk_b, wasm.__wbindgen_export);
            const len3 = WASM_VECTOR_LEN;
            wasm.safetyNumberFor(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred5_0 = r0;
            deferred5_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export5(deferred5_0, deferred5_1, 1);
        }
    }
    exports.safetyNumberFor = safetyNumberFor;
    function __wbg_get_imports() {
        const import0 = {
            __proto__: null,
            __wbg_Error_30c8987f7c2ed4e2: function(arg0, arg1) {
                const ret = Error(getStringFromWasm0(arg0, arg1));
                return addHeapObject(ret);
            },
            __wbg_Number_14af1003b8dd5ead: function(arg0) {
                const ret = Number(getObject(arg0));
                return ret;
            },
            __wbg_String_8564e559799eccda: function(arg0, arg1) {
                const ret = String(getObject(arg1));
                const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
                const len1 = WASM_VECTOR_LEN;
                getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
                getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
            },
            __wbg_Window_241244be8c9776c1: function(arg0) {
                const ret = getObject(arg0).Window;
                return addHeapObject(ret);
            },
            __wbg_WorkerGlobalScope_8623a7c9030fbce2: function(arg0) {
                const ret = getObject(arg0).WorkerGlobalScope;
                return addHeapObject(ret);
            },
            __wbg___wbindgen_bigint_get_as_i64_a2383202b9353e4c: function(arg0, arg1) {
                const v = getObject(arg1);
                const ret = typeof(v) === 'bigint' ? v : undefined;
                getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
                getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
            },
            __wbg___wbindgen_boolean_get_5b446f51afd21013: function(arg0) {
                const v = getObject(arg0);
                const ret = typeof(v) === 'boolean' ? v : undefined;
                return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
            },
            __wbg___wbindgen_debug_string_4687d8d8c2017d52: function(arg0, arg1) {
                const ret = debugString(getObject(arg1));
                const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
                const len1 = WASM_VECTOR_LEN;
                getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
                getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
            },
            __wbg___wbindgen_in_92f62ee1427d9e49: function(arg0, arg1) {
                const ret = getObject(arg0) in getObject(arg1);
                return ret;
            },
            __wbg___wbindgen_is_bigint_b123553bed3bb382: function(arg0) {
                const ret = typeof(getObject(arg0)) === 'bigint';
                return ret;
            },
            __wbg___wbindgen_is_function_1f9d30630b8b1d3d: function(arg0) {
                const ret = typeof(getObject(arg0)) === 'function';
                return ret;
            },
            __wbg___wbindgen_is_null_e343b7d08827ba72: function(arg0) {
                const ret = getObject(arg0) === null;
                return ret;
            },
            __wbg___wbindgen_is_object_3c45d4f2dde4e749: function(arg0) {
                const val = getObject(arg0);
                const ret = typeof(val) === 'object' && val !== null;
                return ret;
            },
            __wbg___wbindgen_is_string_90b56bc79aad6f6c: function(arg0) {
                const ret = typeof(getObject(arg0)) === 'string';
                return ret;
            },
            __wbg___wbindgen_is_undefined_8865fb403f8fe9d8: function(arg0) {
                const ret = getObject(arg0) === undefined;
                return ret;
            },
            __wbg___wbindgen_jsval_eq_02babf21faa37971: function(arg0, arg1) {
                const ret = getObject(arg0) === getObject(arg1);
                return ret;
            },
            __wbg___wbindgen_jsval_loose_eq_677f21e468d6b461: function(arg0, arg1) {
                const ret = getObject(arg0) == getObject(arg1);
                return ret;
            },
            __wbg___wbindgen_number_get_2e0e7dee9f701a71: function(arg0, arg1) {
                const obj = getObject(arg1);
                const ret = typeof(obj) === 'number' ? obj : undefined;
                getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
                getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
            },
            __wbg___wbindgen_string_get_0380ccaa2f57f0d9: function(arg0, arg1) {
                const obj = getObject(arg1);
                const ret = typeof(obj) === 'string' ? obj : undefined;
                var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
                var len1 = WASM_VECTOR_LEN;
                getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
                getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
            },
            __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
                throw new Error(getStringFromWasm0(arg0, arg1));
            },
            __wbg__wbg_cb_unref_dcc1a90847f04c41: function(arg0) {
                getObject(arg0)._wbg_cb_unref();
            },
            __wbg_abort_5b288d575f2b02d1: function() { return handleError(function (arg0) {
                getObject(arg0).abort();
            }, arguments); },
            __wbg_add_3bb371e0f5f02043: function() { return handleError(function (arg0, arg1, arg2) {
                const ret = getObject(arg0).add(getObject(arg1), getObject(arg2));
                return addHeapObject(ret);
            }, arguments); },
            __wbg_bound_eae153ae7e09e03b: function() { return handleError(function (arg0, arg1, arg2, arg3) {
                const ret = IDBKeyRange.bound(getObject(arg0), getObject(arg1), arg2 !== 0, arg3 !== 0);
                return addHeapObject(ret);
            }, arguments); },
            __wbg_call_1875a20c43a36133: function() { return handleError(function (arg0, arg1, arg2, arg3) {
                const ret = getObject(arg0).call(getObject(arg1), getObject(arg2), getObject(arg3));
                return addHeapObject(ret);
            }, arguments); },
            __wbg_call_187d372bd5fdd4aa: function() { return handleError(function (arg0, arg1, arg2) {
                const ret = getObject(arg0).call(getObject(arg1), getObject(arg2));
                return addHeapObject(ret);
            }, arguments); },
            __wbg_call_6137034ef55c9d0f: function() { return handleError(function (arg0, arg1) {
                const ret = getObject(arg0).call(getObject(arg1));
                return addHeapObject(ret);
            }, arguments); },
            __wbg_clearTimeout_113b1cde814ec762: function(arg0) {
                const ret = clearTimeout(takeObject(arg0));
                return addHeapObject(ret);
            },
            __wbg_clear_cddefc9ecd04898f: function() { return handleError(function (arg0) {
                const ret = getObject(arg0).clear();
                return addHeapObject(ret);
            }, arguments); },
            __wbg_close_4db7a0c12586beb7: function(arg0) {
                getObject(arg0).close();
            },
            __wbg_code_10178722c2b239d2: function(arg0) {
                const ret = getObject(arg0).code;
                return ret;
            },
            __wbg_commit_ebd6d9676954e0d2: function() { return handleError(function (arg0) {
                getObject(arg0).commit();
            }, arguments); },
            __wbg_continue_f83efa8d7e649e16: function() { return handleError(function (arg0) {
                getObject(arg0).continue();
            }, arguments); },
            __wbg_count_736ae4794c46aa3c: function() { return handleError(function (arg0) {
                const ret = getObject(arg0).count();
                return addHeapObject(ret);
            }, arguments); },
            __wbg_count_86dbe029d96bf3e0: function() { return handleError(function (arg0) {
                const ret = getObject(arg0).count();
                return addHeapObject(ret);
            }, arguments); },
            __wbg_createIndex_24fc91f6a1786f0c: function() { return handleError(function (arg0, arg1, arg2, arg3) {
                const ret = getObject(arg0).createIndex(getStringFromWasm0(arg1, arg2), getObject(arg3));
                return addHeapObject(ret);
            }, arguments); },
            __wbg_createIndex_a15ba7a7d0d24c0f: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
                const ret = getObject(arg0).createIndex(getStringFromWasm0(arg1, arg2), getObject(arg3), getObject(arg4));
                return addHeapObject(ret);
            }, arguments); },
            __wbg_createObjectStore_84e0f5101158c82d: function() { return handleError(function (arg0, arg1, arg2) {
                const ret = getObject(arg0).createObjectStore(getStringFromWasm0(arg1, arg2));
                return addHeapObject(ret);
            }, arguments); },
            __wbg_crypto_38df2bab126b63dc: function(arg0) {
                const ret = getObject(arg0).crypto;
                return addHeapObject(ret);
            },
            __wbg_deleteObjectStore_d9cb4c41d852edd4: function() { return handleError(function (arg0, arg1, arg2) {
                getObject(arg0).deleteObjectStore(getStringFromWasm0(arg1, arg2));
            }, arguments); },
            __wbg_delete_9c4b670c051866f3: function() { return handleError(function (arg0) {
                const ret = getObject(arg0).delete();
                return addHeapObject(ret);
            }, arguments); },
            __wbg_delete_efcc1a7f91e815b8: function() { return handleError(function (arg0, arg1) {
                const ret = getObject(arg0).delete(getObject(arg1));
                return addHeapObject(ret);
            }, arguments); },
            __wbg_done_b41a1d26cdb37fb6: function(arg0) {
                const ret = getObject(arg0).done;
                return ret;
            },
            __wbg_entries_fb6397112b1de25f: function(arg0) {
                const ret = Object.entries(getObject(arg0));
                return addHeapObject(ret);
            },
            __wbg_error_6a23b57453026a47: function() { return handleError(function (arg0) {
                const ret = getObject(arg0).error;
                return isLikeNone(ret) ? 0 : addHeapObject(ret);
            }, arguments); },
            __wbg_getAllKeys_2540c47f21cb3f26: function() { return handleError(function (arg0) {
                const ret = getObject(arg0).getAllKeys();
                return addHeapObject(ret);
            }, arguments); },
            __wbg_getAll_71532a5786eff544: function() { return handleError(function (arg0) {
                const ret = getObject(arg0).getAll();
                return addHeapObject(ret);
            }, arguments); },
            __wbg_getAll_88f7699c4d2f2318: function() { return handleError(function (arg0, arg1, arg2) {
                const ret = getObject(arg0).getAll(getObject(arg1), arg2 >>> 0);
                return addHeapObject(ret);
            }, arguments); },
            __wbg_getAll_8e8725d9e9b7d026: function() { return handleError(function (arg0, arg1) {
                const ret = getObject(arg0).getAll(getObject(arg1));
                return addHeapObject(ret);
            }, arguments); },
            __wbg_getAll_ed90603b488e51b6: function() { return handleError(function (arg0) {
                const ret = getObject(arg0).getAll();
                return addHeapObject(ret);
            }, arguments); },
            __wbg_getRandomValues_436a51d0629d84e1: function() { return handleError(function (arg0, arg1) {
                globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
            }, arguments); },
            __wbg_getRandomValues_973dabfb0ad1769f: function() { return handleError(function (arg0, arg1) {
                globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
            }, arguments); },
            __wbg_getRandomValues_c44a50d8cfdaebeb: function() { return handleError(function (arg0, arg1) {
                getObject(arg0).getRandomValues(getObject(arg1));
            }, arguments); },
            __wbg_get_0fb44e185f164033: function() { return handleError(function (arg0, arg1) {
                const ret = getObject(arg0).get(getObject(arg1));
                return addHeapObject(ret);
            }, arguments); },
            __wbg_get_31af05bd4842a84f: function() { return handleError(function (arg0, arg1) {
                const ret = Reflect.get(getObject(arg0), getObject(arg1));
                return addHeapObject(ret);
            }, arguments); },
            __wbg_get_658f6698067d9515: function() { return handleError(function (arg0, arg1) {
                const ret = Reflect.get(getObject(arg0), getObject(arg1));
                return addHeapObject(ret);
            }, arguments); },
            __wbg_get_6c896e0571ddae51: function(arg0, arg1) {
                const ret = getObject(arg0)[arg1 >>> 0];
                return addHeapObject(ret);
            },
            __wbg_get_e06b8725897cb193: function() { return handleError(function (arg0, arg1) {
                const ret = getObject(arg0).get(getObject(arg1));
                return addHeapObject(ret);
            }, arguments); },
            __wbg_get_unchecked_288889d017702237: function(arg0, arg1) {
                const ret = getObject(arg0)[arg1 >>> 0];
                return addHeapObject(ret);
            },
            __wbg_get_with_ref_key_6412cf3094599694: function(arg0, arg1) {
                const ret = getObject(arg0)[getObject(arg1)];
                return addHeapObject(ret);
            },
            __wbg_global_94a489d2e6a0c5fd: function(arg0) {
                const ret = getObject(arg0).global;
                return addHeapObject(ret);
            },
            __wbg_index_00cd34642ec64608: function() { return handleError(function (arg0, arg1, arg2) {
                const ret = getObject(arg0).index(getStringFromWasm0(arg1, arg2));
                return addHeapObject(ret);
            }, arguments); },
            __wbg_indexedDB_47c354eb27472a00: function() { return handleError(function (arg0) {
                const ret = getObject(arg0).indexedDB;
                return isLikeNone(ret) ? 0 : addHeapObject(ret);
            }, arguments); },
            __wbg_indexedDB_53d75531b7daa0cd: function() { return handleError(function (arg0) {
                const ret = getObject(arg0).indexedDB;
                return isLikeNone(ret) ? 0 : addHeapObject(ret);
            }, arguments); },
            __wbg_indexedDB_ce6c5fa2f610f212: function() { return handleError(function (arg0) {
                const ret = getObject(arg0).indexedDB;
                return isLikeNone(ret) ? 0 : addHeapObject(ret);
            }, arguments); },
            __wbg_instanceof_ArrayBuffer_a99f175873e5d9b8: function(arg0) {
                let result;
                try {
                    result = getObject(arg0) instanceof ArrayBuffer;
                } catch (_) {
                    result = false;
                }
                const ret = result;
                return ret;
            },
            __wbg_instanceof_CursorSys_383984afc1fa1bbc: function(arg0) {
                let result;
                try {
                    result = getObject(arg0) instanceof IDBCursorWithValue;
                } catch (_) {
                    result = false;
                }
                const ret = result;
                return ret;
            },
            __wbg_instanceof_DomException_550db3f9465a933f: function(arg0) {
                let result;
                try {
                    result = getObject(arg0) instanceof DOMException;
                } catch (_) {
                    result = false;
                }
                const ret = result;
                return ret;
            },
            __wbg_instanceof_Error_80a725f81f2e102d: function(arg0) {
                let result;
                try {
                    result = getObject(arg0) instanceof Error;
                } catch (_) {
                    result = false;
                }
                const ret = result;
                return ret;
            },
            __wbg_instanceof_IdbCursor_ea33e6dcfa426dd8: function(arg0) {
                let result;
                try {
                    result = getObject(arg0) instanceof IDBCursor;
                } catch (_) {
                    result = false;
                }
                const ret = result;
                return ret;
            },
            __wbg_instanceof_IdbDatabase_ee9e122a32a24d91: function(arg0) {
                let result;
                try {
                    result = getObject(arg0) instanceof IDBDatabase;
                } catch (_) {
                    result = false;
                }
                const ret = result;
                return ret;
            },
            __wbg_instanceof_IdbOpenDbRequest_dec5e318537dc9af: function(arg0) {
                let result;
                try {
                    result = getObject(arg0) instanceof IDBOpenDBRequest;
                } catch (_) {
                    result = false;
                }
                const ret = result;
                return ret;
            },
            __wbg_instanceof_IdbRequest_d33cf2b2aa926afc: function(arg0) {
                let result;
                try {
                    result = getObject(arg0) instanceof IDBRequest;
                } catch (_) {
                    result = false;
                }
                const ret = result;
                return ret;
            },
            __wbg_instanceof_Map_b2611749102d7ba3: function(arg0) {
                let result;
                try {
                    result = getObject(arg0) instanceof Map;
                } catch (_) {
                    result = false;
                }
                const ret = result;
                return ret;
            },
            __wbg_instanceof_Promise_e1dc6893aa1ece28: function(arg0) {
                let result;
                try {
                    result = getObject(arg0) instanceof Promise;
                } catch (_) {
                    result = false;
                }
                const ret = result;
                return ret;
            },
            __wbg_instanceof_Uint8Array_828cef2aaacafc31: function(arg0) {
                let result;
                try {
                    result = getObject(arg0) instanceof Uint8Array;
                } catch (_) {
                    result = false;
                }
                const ret = result;
                return ret;
            },
            __wbg_isArray_2b41c29f43a3fb12: function(arg0) {
                const ret = Array.isArray(getObject(arg0));
                return ret;
            },
            __wbg_isArray_e15a2ff68ffdbef2: function(arg0) {
                const ret = Array.isArray(getObject(arg0));
                return ret;
            },
            __wbg_isSafeInteger_717808ad6a54bd9e: function(arg0) {
                const ret = Number.isSafeInteger(getObject(arg0));
                return ret;
            },
            __wbg_item_1fc482e3550e320f: function(arg0, arg1, arg2) {
                const ret = getObject(arg1).item(arg2 >>> 0);
                var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
                var len1 = WASM_VECTOR_LEN;
                getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
                getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
            },
            __wbg_iterator_e3c31c892080e444: function() {
                const ret = Symbol.iterator;
                return addHeapObject(ret);
            },
            __wbg_key_46ce184affdc8d18: function() { return handleError(function (arg0) {
                const ret = getObject(arg0).key;
                return addHeapObject(ret);
            }, arguments); },
            __wbg_length_7f3c00c40364105e: function(arg0) {
                const ret = getObject(arg0).length;
                return ret;
            },
            __wbg_length_d4bdea10311bd9cf: function(arg0) {
                const ret = getObject(arg0).length;
                return ret;
            },
            __wbg_lowerBound_dda05d4f8e328485: function() { return handleError(function (arg0, arg1) {
                const ret = IDBKeyRange.lowerBound(getObject(arg0), arg1 !== 0);
                return addHeapObject(ret);
            }, arguments); },
            __wbg_message_5f8387f0c32b90a7: function(arg0) {
                const ret = getObject(arg0).message;
                return addHeapObject(ret);
            },
            __wbg_message_d988ea596c5f5c9a: function(arg0, arg1) {
                const ret = getObject(arg1).message;
                const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
                const len1 = WASM_VECTOR_LEN;
                getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
                getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
            },
            __wbg_msCrypto_bd5a034af96bcba6: function(arg0) {
                const ret = getObject(arg0).msCrypto;
                return addHeapObject(ret);
            },
            __wbg_name_30c2cf5d3e6226e8: function(arg0, arg1) {
                const ret = getObject(arg1).name;
                const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
                const len1 = WASM_VECTOR_LEN;
                getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
                getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
            },
            __wbg_new_1dbf7428bba60a42: function(arg0) {
                const ret = new Uint8Array(getObject(arg0));
                return addHeapObject(ret);
            },
            __wbg_new_343a093a3c2ffb4e: function(arg0, arg1) {
                const ret = new Error(getStringFromWasm0(arg0, arg1));
                return addHeapObject(ret);
            },
            __wbg_new_617a8cdb8bb1130e: function() {
                const ret = new Object();
                return addHeapObject(ret);
            },
            __wbg_new_ee2291f50781bf1d: function() {
                const ret = new Array();
                return addHeapObject(ret);
            },
            __wbg_new_from_slice_9a868026ffa4208a: function(arg0, arg1) {
                const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
                return addHeapObject(ret);
            },
            __wbg_new_typed_b01cb72a8af741a3: function(arg0, arg1) {
                try {
                    var state0 = {a: arg0, b: arg1};
                    var cb0 = (arg0, arg1) => {
                        const a = state0.a;
                        state0.a = 0;
                        try {
                            return __wasm_bindgen_func_elem_4585(a, state0.b, arg0, arg1);
                        } finally {
                            state0.a = a;
                        }
                    };
                    const ret = new Promise(cb0);
                    return addHeapObject(ret);
                } finally {
                    state0.a = 0;
                }
            },
            __wbg_new_with_length_3da0ad195f6f63ba: function(arg0) {
                const ret = new Uint8Array(arg0 >>> 0);
                return addHeapObject(ret);
            },
            __wbg_next_33784799010f1bbe: function(arg0) {
                const ret = getObject(arg0).next;
                return addHeapObject(ret);
            },
            __wbg_next_f4aac29c42af995c: function() { return handleError(function (arg0) {
                const ret = getObject(arg0).next();
                return addHeapObject(ret);
            }, arguments); },
            __wbg_node_84ea875411254db1: function(arg0) {
                const ret = getObject(arg0).node;
                return addHeapObject(ret);
            },
            __wbg_now_aa4ccb83129e9e55: function() {
                const ret = Date.now();
                return ret;
            },
            __wbg_now_e7c6795a7f81e10f: function(arg0) {
                const ret = getObject(arg0).now();
                return ret;
            },
            __wbg_objectStoreNames_19a06aba400d0baf: function(arg0) {
                const ret = getObject(arg0).objectStoreNames;
                return addHeapObject(ret);
            },
            __wbg_objectStore_43178e7a3459e234: function() { return handleError(function (arg0, arg1, arg2) {
                const ret = getObject(arg0).objectStore(getStringFromWasm0(arg1, arg2));
                return addHeapObject(ret);
            }, arguments); },
            __wbg_oldVersion_bee6d60861717ba6: function(arg0) {
                const ret = getObject(arg0).oldVersion;
                return ret;
            },
            __wbg_openCursor_50c5809d0805ebb3: function() { return handleError(function (arg0, arg1) {
                const ret = getObject(arg0).openCursor(getObject(arg1));
                return addHeapObject(ret);
            }, arguments); },
            __wbg_openCursor_6efcf867fdf4e754: function() { return handleError(function (arg0) {
                const ret = getObject(arg0).openCursor();
                return addHeapObject(ret);
            }, arguments); },
            __wbg_openCursor_a024d2ed7acfdfd0: function() { return handleError(function (arg0) {
                const ret = getObject(arg0).openCursor();
                return addHeapObject(ret);
            }, arguments); },
            __wbg_open_86a803dec082fde7: function() { return handleError(function (arg0, arg1, arg2) {
                const ret = getObject(arg0).open(getStringFromWasm0(arg1, arg2));
                return addHeapObject(ret);
            }, arguments); },
            __wbg_open_dbf85f9611885c1b: function() { return handleError(function (arg0, arg1, arg2, arg3) {
                const ret = getObject(arg0).open(getStringFromWasm0(arg1, arg2), arg3 >>> 0);
                return addHeapObject(ret);
            }, arguments); },
            __wbg_parse_0fc53dead14b3b42: function() { return handleError(function (arg0, arg1) {
                const ret = JSON.parse(getStringFromWasm0(arg0, arg1));
                return addHeapObject(ret);
            }, arguments); },
            __wbg_performance_3fcf6e32a7e1ed0a: function(arg0) {
                const ret = getObject(arg0).performance;
                return addHeapObject(ret);
            },
            __wbg_process_44c7a14e11e9f69e: function(arg0) {
                const ret = getObject(arg0).process;
                return addHeapObject(ret);
            },
            __wbg_prototypesetcall_bc27214492979395: function(arg0, arg1, arg2) {
                Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), getObject(arg2));
            },
            __wbg_push_2baf45db356cf468: function(arg0, arg1) {
                const ret = getObject(arg0).push(getObject(arg1));
                return ret;
            },
            __wbg_put_378af428b16ba8f2: function() { return handleError(function (arg0, arg1, arg2) {
                const ret = getObject(arg0).put(getObject(arg1), getObject(arg2));
                return addHeapObject(ret);
            }, arguments); },
            __wbg_queueMicrotask_9833f9a49df95a49: function(arg0) {
                const ret = getObject(arg0).queueMicrotask;
                return addHeapObject(ret);
            },
            __wbg_queueMicrotask_a72f977e97f23c5f: function(arg0) {
                queueMicrotask(getObject(arg0));
            },
            __wbg_randomFillSync_6c25eac9869eb53c: function() { return handleError(function (arg0, arg1) {
                getObject(arg0).randomFillSync(takeObject(arg1));
            }, arguments); },
            __wbg_readyState_4566441ff2bd25dc: function(arg0) {
                const ret = getObject(arg0).readyState;
                return (__wbindgen_enum_IdbRequestReadyState.indexOf(ret) + 1 || 3) - 1;
            },
            __wbg_request_64abeba15a72c084: function(arg0) {
                const ret = getObject(arg0).request;
                return addHeapObject(ret);
            },
            __wbg_request_72a78988f2edecad: function(arg0) {
                const ret = getObject(arg0).request;
                return addHeapObject(ret);
            },
            __wbg_require_b4edbdcf3e2a1ef0: function() { return handleError(function () {
                const ret = module.require;
                return addHeapObject(ret);
            }, arguments); },
            __wbg_resolve_0076e10020304ede: function(arg0) {
                const ret = Promise.resolve(getObject(arg0));
                return addHeapObject(ret);
            },
            __wbg_result_ea60156c5cd4726f: function() { return handleError(function (arg0) {
                const ret = getObject(arg0).result;
                return addHeapObject(ret);
            }, arguments); },
            __wbg_setTimeout_ef24d2fc3ad97385: function() { return handleError(function (arg0, arg1) {
                const ret = setTimeout(getObject(arg0), arg1);
                return addHeapObject(ret);
            }, arguments); },
            __wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {
                getObject(arg0)[takeObject(arg1)] = takeObject(arg2);
            },
            __wbg_set_bea140a88be9b277: function(arg0, arg1, arg2) {
                getObject(arg0)[arg1 >>> 0] = takeObject(arg2);
            },
            __wbg_set_onabort_ce1ccad84ebb2dbd: function(arg0, arg1) {
                getObject(arg0).onabort = getObject(arg1);
            },
            __wbg_set_oncomplete_14cd563f5d15546c: function(arg0, arg1) {
                getObject(arg0).oncomplete = getObject(arg1);
            },
            __wbg_set_onerror_00facdd255f06ed6: function(arg0, arg1) {
                getObject(arg0).onerror = getObject(arg1);
            },
            __wbg_set_onerror_24dddc0e8dc54601: function(arg0, arg1) {
                getObject(arg0).onerror = getObject(arg1);
            },
            __wbg_set_onsuccess_e970bffc8d0e7520: function(arg0, arg1) {
                getObject(arg0).onsuccess = getObject(arg1);
            },
            __wbg_set_onupgradeneeded_f9d42df70899331b: function(arg0, arg1) {
                getObject(arg0).onupgradeneeded = getObject(arg1);
            },
            __wbg_set_unique_4b3007303f08d9bd: function(arg0, arg1) {
                getObject(arg0).unique = arg1 !== 0;
            },
            __wbg_static_accessor_GLOBAL_266715b9d96ba635: function() {
                const ret = typeof global === 'undefined' ? null : global;
                return isLikeNone(ret) ? 0 : addHeapObject(ret);
            },
            __wbg_static_accessor_GLOBAL_THIS_10fb7dc1ae063179: function() {
                const ret = typeof globalThis === 'undefined' ? null : globalThis;
                return isLikeNone(ret) ? 0 : addHeapObject(ret);
            },
            __wbg_static_accessor_SELF_0b583911f537483a: function() {
                const ret = typeof self === 'undefined' ? null : self;
                return isLikeNone(ret) ? 0 : addHeapObject(ret);
            },
            __wbg_static_accessor_WINDOW_d7f903d1508cbdc4: function() {
                const ret = typeof window === 'undefined' ? null : window;
                return isLikeNone(ret) ? 0 : addHeapObject(ret);
            },
            __wbg_stringify_52ff602c1cc4fbb6: function() { return handleError(function (arg0) {
                const ret = JSON.stringify(getObject(arg0));
                return addHeapObject(ret);
            }, arguments); },
            __wbg_subarray_002b94d5e13d1411: function(arg0, arg1, arg2) {
                const ret = getObject(arg0).subarray(arg1 >>> 0, arg2 >>> 0);
                return addHeapObject(ret);
            },
            __wbg_target_38ae9feb025b820c: function(arg0) {
                const ret = getObject(arg0).target;
                return isLikeNone(ret) ? 0 : addHeapObject(ret);
            },
            __wbg_then_c949d5a25a4e78f8: function(arg0, arg1, arg2) {
                const ret = getObject(arg0).then(getObject(arg1), getObject(arg2));
                return addHeapObject(ret);
            },
            __wbg_then_e71170d78fcf8954: function(arg0, arg1) {
                const ret = getObject(arg0).then(getObject(arg1));
                return addHeapObject(ret);
            },
            __wbg_toString_0a6162345e699dea: function(arg0) {
                const ret = getObject(arg0).toString();
                return addHeapObject(ret);
            },
            __wbg_transaction_3a02c7e8ef4fa771: function(arg0) {
                const ret = getObject(arg0).transaction;
                return isLikeNone(ret) ? 0 : addHeapObject(ret);
            },
            __wbg_transaction_55a3a4e0134a0fd6: function() { return handleError(function (arg0, arg1, arg2, arg3) {
                const ret = getObject(arg0).transaction(getStringFromWasm0(arg1, arg2), __wbindgen_enum_IdbTransactionMode[arg3]);
                return addHeapObject(ret);
            }, arguments); },
            __wbg_transaction_ab690a49887e7ef7: function() { return handleError(function (arg0, arg1, arg2) {
                const ret = getObject(arg0).transaction(getObject(arg1), __wbindgen_enum_IdbTransactionMode[arg2]);
                return addHeapObject(ret);
            }, arguments); },
            __wbg_transaction_b05ed4d3c23955f1: function(arg0) {
                const ret = getObject(arg0).transaction;
                return addHeapObject(ret);
            },
            __wbg_update_ff4207827735d622: function() { return handleError(function (arg0, arg1) {
                const ret = getObject(arg0).update(getObject(arg1));
                return addHeapObject(ret);
            }, arguments); },
            __wbg_upperBound_0bd210e294c6b463: function() { return handleError(function (arg0, arg1) {
                const ret = IDBKeyRange.upperBound(getObject(arg0), arg1 !== 0);
                return addHeapObject(ret);
            }, arguments); },
            __wbg_value_e6653e661698cb71: function() { return handleError(function (arg0) {
                const ret = getObject(arg0).value;
                return addHeapObject(ret);
            }, arguments); },
            __wbg_value_f3c585ee8f5ba40c: function(arg0) {
                const ret = getObject(arg0).value;
                return addHeapObject(ret);
            },
            __wbg_version_178889abc3c54e96: function(arg0) {
                const ret = getObject(arg0).version;
                return ret;
            },
            __wbg_versions_276b2795b1c6a219: function(arg0) {
                const ret = getObject(arg0).versions;
                return addHeapObject(ret);
            },
            __wbg_wasmcore_new: function(arg0) {
                const ret = WasmCore.__wrap(arg0);
                return addHeapObject(ret);
            },
            __wbg_wasmlinkweb_new: function(arg0) {
                const ret = WasmLinkWeb.__wrap(arg0);
                return addHeapObject(ret);
            },
            __wbindgen_generic_0000000000000001: function(arg0, arg1) {
                // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 67, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
                const ret = makeMutClosure(arg0, arg1, __wasm_bindgen_func_elem_4521);
                return addHeapObject(ret);
            },
            __wbindgen_generic_0000000000000002: function(arg0, arg1) {
                // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("Event")], shim_idx: 205, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
                const ret = makeMutClosure(arg0, arg1, __wasm_bindgen_func_elem_5637);
                return addHeapObject(ret);
            },
            __wbindgen_generic_0000000000000003: function(arg0, arg1) {
                // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("IDBVersionChangeEvent")], shim_idx: 67, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
                const ret = makeMutClosure(arg0, arg1, __wasm_bindgen_func_elem_4521_49);
                return addHeapObject(ret);
            },
            __wbindgen_generic_0000000000000004: function(arg0, arg1) {
                // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [], shim_idx: 171, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
                const ret = makeMutClosure(arg0, arg1, __wasm_bindgen_func_elem_4477);
                return addHeapObject(ret);
            },
            __wbindgen_generic_0000000000000005: function(arg0) {
                // Cast intrinsic for `F64 -> Externref`.
                const ret = arg0;
                return addHeapObject(ret);
            },
            __wbindgen_generic_0000000000000006: function(arg0) {
                // Cast intrinsic for `I64 -> Externref`.
                const ret = arg0;
                return addHeapObject(ret);
            },
            __wbindgen_generic_0000000000000007: function(arg0, arg1) {
                // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
                const ret = getArrayU8FromWasm0(arg0, arg1);
                return addHeapObject(ret);
            },
            __wbindgen_generic_0000000000000008: function(arg0, arg1) {
                // Cast intrinsic for `Ref(String) -> Externref`.
                const ret = getStringFromWasm0(arg0, arg1);
                return addHeapObject(ret);
            },
            __wbindgen_generic_0000000000000009: function(arg0) {
                // Cast intrinsic for `U64 -> Externref`.
                const ret = BigInt.asUintN(64, arg0);
                return addHeapObject(ret);
            },
            __wbindgen_object_clone_ref: function(arg0) {
                const ret = getObject(arg0);
                return addHeapObject(ret);
            },
            __wbindgen_object_drop_ref: function(arg0) {
                takeObject(arg0);
            },
        };
        return {
            __proto__: null,
            "./chatyy_crypto_wasm_bg.js": import0,
        };
    }

    function __wasm_bindgen_func_elem_4477(arg0, arg1) {
        wasm.__wasm_bindgen_func_elem_4477(arg0, arg1);
    }

    function __wasm_bindgen_func_elem_5637(arg0, arg1, arg2) {
        wasm.__wasm_bindgen_func_elem_5637(arg0, arg1, addHeapObject(arg2));
    }

    function __wasm_bindgen_func_elem_4585(arg0, arg1, arg2, arg3) {
        wasm.__wasm_bindgen_func_elem_4585(arg0, arg1, addHeapObject(arg2), addHeapObject(arg3));
    }

    function __wasm_bindgen_func_elem_4521(arg0, arg1, arg2) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.__wasm_bindgen_func_elem_4521(retptr, arg0, arg1, addHeapObject(arg2));
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            if (r1) {
                throw takeObject(r0);
            }
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }

    function __wasm_bindgen_func_elem_4521_49(arg0, arg1, arg2) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.__wasm_bindgen_func_elem_4521_49(retptr, arg0, arg1, addHeapObject(arg2));
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            if (r1) {
                throw takeObject(r0);
            }
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }


    const __wbindgen_enum_IdbRequestReadyState = ["pending", "done"];


    const __wbindgen_enum_IdbTransactionMode = ["readonly", "readwrite", "versionchange", "readwriteflush", "cleanup"];
    const WasmCoreFinalization = (typeof FinalizationRegistry === 'undefined')
        ? { register: () => {}, unregister: () => {} }
        : new FinalizationRegistry(ptr => wasm.__wbg_wasmcore_free(ptr, 1));
    const WasmLinkWebFinalization = (typeof FinalizationRegistry === 'undefined')
        ? { register: () => {}, unregister: () => {} }
        : new FinalizationRegistry(ptr => wasm.__wbg_wasmlinkweb_free(ptr, 1));

    function addHeapObject(obj) {
        if (heap_next === heap.length) heap.push(heap.length + 1);
        const idx = heap_next;
        heap_next = heap[idx];

        heap[idx] = obj;
        return idx;
    }

    function _assertClass(instance, klass) {
        if (!(instance instanceof klass)) {
            throw new Error(`expected instance of ${klass.name}`);
        }
    }

    const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
        ? { register: () => {}, unregister: () => {} }
        : new FinalizationRegistry(state => wasm.__wbindgen_export4(state.a, state.b));

    function debugString(val) {
        // primitive types
        const type = typeof val;
        if (type == 'number' || type == 'boolean' || val == null) {
            return  `${val}`;
        }
        if (type == 'string') {
            return `"${val}"`;
        }
        if (type == 'symbol') {
            const description = val.description;
            if (description == null) {
                return 'Symbol';
            } else {
                return `Symbol(${description})`;
            }
        }
        if (type == 'function') {
            const name = val.name;
            if (typeof name == 'string' && name.length > 0) {
                return `Function(${name})`;
            } else {
                return 'Function';
            }
        }
        // objects
        if (Array.isArray(val)) {
            const length = val.length;
            let debug = '[';
            if (length > 0) {
                debug += debugString(val[0]);
            }
            for(let i = 1; i < length; i++) {
                debug += ', ' + debugString(val[i]);
            }
            debug += ']';
            return debug;
        }
        // Test for built-in
        const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
        let className;
        if (builtInMatches && builtInMatches.length > 1) {
            className = builtInMatches[1];
        } else {
            // Failed to match the standard '[object ClassName]'
            return toString.call(val);
        }
        if (className == 'Object') {
            // we're a user defined class or Object
            // JSON.stringify avoids problems with cycles, and is generally much
            // easier than looping through ownProperties of `val`.
            try {
                return 'Object(' + JSON.stringify(val) + ')';
            } catch (_) {
                return 'Object';
            }
        }
        // errors
        if (val instanceof Error) {
            return `${val.name}: ${val.message}\n${val.stack}`;
        }
        // TODO we could test for more things here, like `Set`s and `Map`s.
        return className;
    }

    function dropObject(idx) {
        if (idx < 1028) return;
        heap[idx] = heap_next;
        heap_next = idx;
    }

    function getArrayU8FromWasm0(ptr, len) {
        ptr = ptr >>> 0;
        return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
    }

    let cachedDataViewMemory0 = null;
    function getDataViewMemory0() {
        if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
            cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
        }
        return cachedDataViewMemory0;
    }

    function getStringFromWasm0(ptr, len) {
        return decodeText(ptr >>> 0, len);
    }

    let cachedUint8ArrayMemory0 = null;
    function getUint8ArrayMemory0() {
        if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
            cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
        }
        return cachedUint8ArrayMemory0;
    }

    function getObject(idx) { return heap[idx]; }

    function handleError(f, args) {
        try {
            return f.apply(this, args);
        } catch (e) {
            wasm.__wbindgen_export3(addHeapObject(e));
        }
    }

    let heap = new Array(1024).fill(undefined);
    heap.push(undefined, null, true, false);

    let heap_next = heap.length;

    function isLikeNone(x) {
        return x === undefined || x === null;
    }

    function makeMutClosure(arg0, arg1, f) {
        const state = { a: arg0, b: arg1, cnt: 1 };
        const real = (...args) => {

            // First up with a closure we increment the internal reference
            // count. This ensures that the Rust closure environment won't
            // be deallocated while we're invoking it.
            state.cnt++;
            const a = state.a;
            state.a = 0;
            try {
                return f(a, state.b, ...args);
            } finally {
                state.a = a;
                real._wbg_cb_unref();
            }
        };
        real._wbg_cb_unref = () => {
            if (--state.cnt === 0) {
                wasm.__wbindgen_export4(state.a, state.b);
                state.a = 0;
                CLOSURE_DTORS.unregister(state);
            }
        };
        CLOSURE_DTORS.register(real, state, state);
        return real;
    }

    function passArray8ToWasm0(arg, malloc) {
        const ptr = malloc(arg.length * 1, 1) >>> 0;
        getUint8ArrayMemory0().set(arg, ptr / 1);
        WASM_VECTOR_LEN = arg.length;
        return ptr;
    }

    function passStringToWasm0(arg, malloc, realloc) {
        if (realloc === undefined) {
            const buf = cachedTextEncoder.encode(arg);
            const ptr = malloc(buf.length, 1) >>> 0;
            getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
            WASM_VECTOR_LEN = buf.length;
            return ptr;
        }

        let len = arg.length;
        let ptr = malloc(len, 1) >>> 0;

        const mem = getUint8ArrayMemory0();

        let offset = 0;

        for (; offset < len; offset++) {
            const code = arg.charCodeAt(offset);
            if (code > 0x7F) break;
            mem[ptr + offset] = code;
        }
        if (offset !== len) {
            if (offset !== 0) {
                arg = arg.slice(offset);
            }
            ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
            const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
            const ret = cachedTextEncoder.encodeInto(arg, view);

            offset += ret.written;
            ptr = realloc(ptr, len, offset, 1) >>> 0;
        }

        WASM_VECTOR_LEN = offset;
        return ptr;
    }

    function takeObject(idx) {
        const ret = getObject(idx);
        dropObject(idx);
        return ret;
    }

    let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
    cachedTextDecoder.decode();
    function decodeText(ptr, len) {
        return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
    }

    const cachedTextEncoder = new TextEncoder();

    if (!('encodeInto' in cachedTextEncoder)) {
        cachedTextEncoder.encodeInto = function (arg, view) {
            const buf = cachedTextEncoder.encode(arg);
            view.set(buf);
            return {
                read: arg.length,
                written: buf.length
            };
        };
    }

    let WASM_VECTOR_LEN = 0;

    let wasmModule, wasmInstance, wasm;
    function __wbg_finalize_init(instance, module) {
        wasmInstance = instance;
        wasm = instance.exports;
        wasmModule = module;
        cachedDataViewMemory0 = null;
        cachedUint8ArrayMemory0 = null;
        return wasm;
    }

    async function __wbg_load(module, imports) {
        if (typeof Response === 'function' && module instanceof Response) {
            if (!module.ok) {
                throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
            }

            if (typeof WebAssembly.instantiateStreaming === 'function') {
                try {
                    return await WebAssembly.instantiateStreaming(module, imports);
                } catch (e) {
                    const validResponse = expectedResponseType(module.type);

                    if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                        console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                    } else { throw e; }
                }
            }

            const bytes = await module.arrayBuffer();
            return await WebAssembly.instantiate(bytes, imports);
        } else {
            const instance = await WebAssembly.instantiate(module, imports);

            if (instance instanceof WebAssembly.Instance) {
                return { instance, module };
            } else {
                return instance;
            }
        }

        function expectedResponseType(type) {
            switch (type) {
                case 'basic': case 'cors': case 'default': return true;
            }
            return false;
        }
    }

    function initSync(module) {
        if (wasm !== undefined) return wasm;


        if (module !== undefined) {
            if (Object.getPrototypeOf(module) === Object.prototype) {
                ({module} = module)
            } else {
                console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
            }
        }

        const imports = __wbg_get_imports();
        if (!(module instanceof WebAssembly.Module)) {
            module = new WebAssembly.Module(module);
        }
        const instance = new WebAssembly.Instance(module, imports);
        return __wbg_finalize_init(instance, module);
    }

    async function __wbg_init(module_or_path) {
        if (wasm !== undefined) return wasm;


        if (module_or_path !== undefined) {
            if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
                ({module_or_path} = module_or_path)
            } else {
                console.warn('using deprecated parameters for the initialization function; pass a single object instead')
            }
        }

        if (module_or_path === undefined && script_src !== undefined) {
            module_or_path = script_src.replace(/\.js$/, "_bg.wasm");
        }
        const imports = __wbg_get_imports();

        if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
            module_or_path = fetch(module_or_path);
        }

        const { instance, module } = await __wbg_load(await module_or_path, imports);

        return __wbg_finalize_init(instance, module);
    }

    return Object.assign(__wbg_init, { initSync }, exports);
})({ __proto__: null });
