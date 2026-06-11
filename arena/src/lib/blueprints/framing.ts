/**
 * Plain-language framing for the blueprint variants. Users pick where their
 * bot runs ("shared vs dedicated vs dedicated + attested"), not a blueprint —
 * the technical blueprint name/ids stay intact underneath, this is
 * presentation only.
 */
export interface InstanceFraming {
  /** Short noun phrase shown as the primary label. */
  label: string;
  /** Compact variant for dense surfaces (headers, table cells). */
  shortLabel: string;
  /** One-sentence consequence the user actually cares about. */
  summary: string;
}

export function instanceFraming(blueprint: {
  isFleet: boolean;
  isTee: boolean;
}): InstanceFraming {
  if (blueprint.isTee) {
    return {
      label: 'Dedicated + TEE',
      shortLabel: 'Dedicated + TEE',
      summary: 'Your own isolated instance with hardware attestation.',
    };
  }
  if (blueprint.isFleet) {
    return {
      label: 'Shared instance',
      shortLabel: 'Shared',
      summary:
        'Your bot runs alongside others on the operator — the cheapest way to run.',
    };
  }
  return {
    label: 'Dedicated instance',
    shortLabel: 'Dedicated',
    summary: 'Your own isolated instance.',
  };
}

/** Same framing keyed by a bot's operator deployment kind. */
export function instanceLabelForOperatorKind(
  kind: 'cloud' | 'instance' | 'tee' | null | undefined,
): string {
  switch (kind) {
    case 'cloud':
      return 'Shared';
    case 'instance':
      return 'Dedicated';
    case 'tee':
      return 'Dedicated + TEE';
    default:
      return 'Unknown';
  }
}
