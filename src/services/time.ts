export function str2Seconds(str: string): number {
  const parts = str.split(':').map(x => parseInt(x));
  switch (parts.length) {
    case 1: {
      const [seconds] = parts;
      if (seconds === undefined || isNaN(seconds))
        throw new Error('Invalid time');
      return seconds;
    }
    case 2: {
      const [minutes, seconds] = parts;
      if (minutes === undefined || isNaN(minutes))
        throw new Error('Invalid minutes');
      if (seconds === undefined || isNaN(seconds))
        throw new Error('Invalid seconds');
      return minutes * 60 + seconds;
    }
    case 3: {
      const [hours, minutes, seconds] = parts;
      if (hours === undefined || isNaN(hours)) throw new Error('Invalid hours');
      if (minutes === undefined || isNaN(minutes))
        throw new Error('Invalid minutes');
      if (seconds === undefined || isNaN(seconds))
        throw new Error('Invalid seconds');
      return hours * 3600 + minutes * 60 + seconds;
    }
    default:
      throw new Error('Invalid time');
  }
}
