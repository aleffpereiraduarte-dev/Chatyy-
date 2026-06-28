/**
 * twilioCall — DEPRECATED no-op stub.
 *
 * The Twilio Voice integration was removed: the Twilio/Telnyx accounts were
 * cancelled and the `@twilio/voice-sdk` dependency was dropped from the app.
 * PSTN dialing now routes through LiveKit + Vonage (see services/pstnCall.js).
 *
 * This file is kept only as a safe stub so any lingering import resolves to
 * inert no-ops instead of crashing the bundle. Do NOT re-add the SDK here.
 */

export async function registerTwilioDevice() {
  return false;
}

export async function startTwilioCall(_creds, _destinationNumber, onStateChange) {
  onStateChange?.('error:Twilio voice has been removed (use LiveKit + Vonage)');
  return { success: false };
}

export function hangupTwilioCall() {}

export function muteTwilioCall() {}

export function sendTwilioDtmf() {}

export function isTwilioCallActive() {
  return false;
}

export function destroyTwilioDevice() {}
