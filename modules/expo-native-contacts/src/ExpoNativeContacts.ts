import { requireNativeModule } from 'expo';

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

export default requireNativeModule<ExpoNativeContactsClass>('ExpoNativeContacts');
