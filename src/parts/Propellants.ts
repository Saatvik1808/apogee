/**
 * LEARNING NOTE: Propellant chemistry drives rocket design
 *
 * A rocket's performance hinges on specific impulse (Isp): how many seconds one
 * kilogram of propellant can produce one kilogram-force of thrust. Higher Isp means
 * more delta-v from the same fuel (Tsiolkovsky: Δv = Isp·g0·ln(m_full/m_empty)).
 *
 * The catch is DENSITY. Liquid hydrogen gives the best chemical Isp (~450 s) but is
 * so light (bulk ~360 kg/m³ when mixed with LOX) that its tanks are huge and heavy
 * relative to the propellant they hold. Kerosene/LOX is dense (~1030 kg/m³) but
 * only ~310 s. That is why real first stages burn kerosene or methane and upper
 * stages burn hydrogen — a trade-off players rediscover in the assembly building.
 *
 * Bulk density = (1 + O/F) / (1/ρ_fuel + O/F/ρ_oxidizer), with O/F the
 * oxidizer-to-fuel mass ratio.
 *
 * Key concepts: specific impulse, mixture ratio, bulk density, tank mass fraction
 */

export type PropellantId = 'kerolox' | 'hydrolox' | 'methalox' | 'hypergolic' | 'solid';

export interface PropellantSpec {
  id: PropellantId;
  name: string;
  short: string;
  /** Bulk density of the mixed propellant load (kg/m³). */
  density: number;
  /** Tank structure mass per cubic metre of tank volume (kg/m³). */
  tankMassPerM3: number;
  /** Tank cost multiplier. */
  costFactor: number;
  /** UI colour. */
  color: string;
  /** Visual tank finish used by the procedural material system. */
  finish: 'white' | 'foam' | 'steel' | 'gray' | 'solid';
}

export const PROPELLANTS: Record<PropellantId, PropellantSpec> = {
  kerolox: {
    id: 'kerolox',
    name: 'RP-1 / LOX (Kerolox)',
    short: 'Kerolox',
    density: 1028,
    tankMassPerM3: 44,
    costFactor: 1,
    color: '#ffb347',
    finish: 'white',
  },
  hydrolox: {
    id: 'hydrolox',
    name: 'LH2 / LOX (Hydrolox)',
    short: 'Hydrolox',
    density: 361,
    tankMassPerM3: 30,
    costFactor: 1.7,
    color: '#7fd4ff',
    finish: 'foam',
  },
  methalox: {
    id: 'methalox',
    name: 'CH4 / LOX (Methalox)',
    short: 'Methalox',
    density: 833,
    tankMassPerM3: 46,
    costFactor: 0.8,
    color: '#b8a3ff',
    finish: 'steel',
  },
  hypergolic: {
    id: 'hypergolic',
    name: 'MMH / NTO (Hypergolic)',
    short: 'Hypergolic',
    density: 1161,
    tankMassPerM3: 70,
    costFactor: 2.2,
    color: '#8dff9e',
    finish: 'gray',
  },
  solid: {
    id: 'solid',
    name: 'APCP (Solid)',
    short: 'Solid',
    density: 1750,
    tankMassPerM3: 0,
    costFactor: 1,
    color: '#ff8a8a',
    finish: 'solid',
  },
};

export const LIQUID_PROPELLANTS: PropellantId[] = ['kerolox', 'methalox', 'hydrolox', 'hypergolic'];
