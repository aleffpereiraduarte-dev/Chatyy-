import { requireOptionalNativeModule } from 'expo';

export interface NativeContact {
  name: string;
  emails: string[];
  phones: string[];
}

declare class ExpoNativeContactsClass {
  /**
   * Check if contacts permission has been granted (synchronous).
   * Returns true if the current authorization status is .authorized.
   */
  hasContactsPermission(): boolean;

  /**
   * Request contacts permission from the user.
   * Returns true if permission was granted, false otherwise.
   * If already granted, returns true immediately.
   */
  requestContactsPermission(): Promise<boolean>;

  /**
   * Fetch all contacts from the device address book.
   * Returns an array of { name, emails, phones } objects.
   * Phones are returned in E.164-ish format (digits + leading +).
   * Only contacts with at least one email or phone are included.
   */
  getAllContacts(): Promise<NativeContact[]>;

  /**
   * Get the total number of contacts (quick count without loading all data).
   */
  getContactCount(): Promise<number>;
}

// [2026-10-10 native-audit] requireOptionalNativeModule: a top-level
// requireNativeModule THROWS inside the module factory when the binary lacks
// the module (Android, web, old builds) and a lazy require() of a throwing
// factory goes to reportFatalError (try/catch around require() does NOT
// help — see AuthContext/expo-chat-cache incident 2026-10-06). Callers already
// treat a null module as "use expo-contacts".
export default requireOptionalNativeModule<ExpoNativeContactsClass>('ExpoNativeContacts') as ExpoNativeContactsClass;
