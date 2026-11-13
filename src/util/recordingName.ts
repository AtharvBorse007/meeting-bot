/** "abc-defg-hij" from a Google Meet link, if it has one. */
export const getMeetingCode = (url: string): string | undefined =>
  url.match(/meet\.google\.com\/(?:lookup\/)?([a-z]{3}-[a-z]{4}-[a-z]{3})/i)?.[1]?.toLowerCase();

export const getRecordingNamePrefix = (provider: 'google' | 'microsoft' | 'zoom') => {
  switch(provider) {
    case 'google':
      return 'Google Meet Recording';
    case 'microsoft':
      return 'Microsoft Teams Recording';
    case 'zoom':
      return 'Zoom Recording';
    default:
      return 'Recording';
  }
};
