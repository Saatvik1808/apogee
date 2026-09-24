/**
 * LEARNING NOTE: Story as data
 *
 * The campaign's narrative lives entirely in data: chapters, briefings, debriefs
 * and RADIO CUES — lines of dialogue attached to triggers ("on liftoff", "when
 * objective 2 completes", "on entering the Moon's sphere of influence", "on loss
 * of signal"). The flight code only reports what happened; a small director
 * matches events against cues and queues the lines. Writers can then change the
 * story without touching game logic, and every line doubles as a teaching
 * moment delivered exactly when the player needs it.
 *
 * The call-outs echo real mission control practice: "go for launch", "max Q",
 * "SECO" (second-stage engine cut-off), loss and acquisition of signal as a
 * spacecraft passes behind the Moon, and the radio blackout of re-entry, when
 * the plasma sheath around a capsule blocks transmissions.
 *
 * Key concepts: data-driven narrative, event triggers, separation of content and
 * code, diegetic tutorials
 */
import type { BodyId } from '../../physics/CelestialBody';
import type { CharacterId } from './Characters';

export interface Beat {
  who: CharacterId;
  text: string;
}

export type RadioTrigger =
  | { on: 'start' }
  | { on: 'liftoff' }
  | { on: 'maxq' }
  | { on: 'staging' }
  | { on: 'space' }
  | { on: 'orbit' }
  | { on: 'soi'; body: BodyId }
  | { on: 'objective'; index: number }
  | { on: 'landed'; body: BodyId }
  | { on: 'reentry' }
  | { on: 'chute' }
  | { on: 'los' }
  | { on: 'aos' }
  | { on: 'descending'; km: number; body: BodyId }
  | { on: 'highg' }
  | { on: 'rendezvous' }
  | { on: 'docked' }
  | { on: 'undocked' };

export interface RadioCue {
  trigger: RadioTrigger;
  lines: Beat[];
  /** Fire at most once per flight (default true). */
  once?: boolean;
}

export interface MissionStory {
  brief: Beat[];
  success: Beat[];
  failure: Beat[];
  radio: RadioCue[];
}

export interface Chapter {
  n: number;
  title: string;
  tagline: string;
  intro: Beat[];
}

export const CHAPTERS: Chapter[] = [
  {
    n: 1,
    title: 'Ignition',
    tagline: 'A new space program has to prove it can fly.',
    intro: [
      { who: 'director', text: 'Welcome to APOGEE. We have three years of funding, one launch complex, and a board that wants results. Let\'s give them some.' },
      { who: 'engineer', text: 'We start small: a solid motor and an instrument probe. Everything you learn today scales all the way to the Moon.' },
    ],
  },
  {
    n: 2,
    title: 'Foothold',
    tagline: 'People and satellites in orbit — and home again.',
    intro: [
      { who: 'director', text: 'Our first satellite changed everything. The board approved a crewed program this morning. Helion Dynamics announced theirs this afternoon.' },
      { who: 'kenji', text: 'Kenji Watanabe. Twelve years flying jets, zero flying rockets. I intend to fix that.' },
    ],
  },
  {
    n: 3,
    title: 'The Long Way Up',
    tagline: '384,400 kilometres to the Moon.',
    intro: [
      { who: 'director', text: 'Helion says they\'ll land on the Moon within two years. We\'re going to beat them — robots first, then people.' },
      { who: 'sofia', text: 'The lunar poles hold water ice in craters that never see sunlight. Every probe we land tells us where to go next.' },
      { who: 'engineer', text: 'Timing is everything now. The Moon moves a full diameter every hour; you aim at where it will be three days after you leave.' },
    ],
  },
  {
    n: 4,
    title: 'Red Horizon',
    tagline: 'The better part of a year, 225 million kilometres, one window.',
    intro: [
      { who: 'director', text: 'The Moon was the proving ground. Mars is the destination. The launch window opens in November — miss it and we wait twenty-six months.' },
      { who: 'engineer', text: 'Earth and Mars line up for a cheap transfer only once per synodic period. Leave early or late and the fuel bill explodes.' },
    ],
  },
  {
    n: 5,
    title: 'Orbital Operations',
    tagline: 'A permanent presence: constellations, a station, rendezvous and docking.',
    intro: [
      { who: 'director', text: 'Flags and footprints are done. The board wants infrastructure now: a relay network, a station, and crews that can find each other in orbit.' },
      { who: 'priya', text: 'Priya Raman. I\'ll command Keystone once it flies. Docking is the hardest thing a pilot does up there — two vehicles, eight kilometres a second, closing at a walking pace.' },
      { who: 'engineer', text: 'Everything you leave in orbit stays there. The tracking station on the main menu keeps every vessel; you can fly any of them again.' },
    ],
  },
];

/** Radio lines used on every flight unless a mission overrides the trigger. */
export const GENERIC_RADIO: RadioCue[] = [
  { trigger: { on: 'liftoff' }, lines: [{ who: 'capcom', text: 'Liftoff! The tower is clear. Clock is running.' }] },
  { trigger: { on: 'maxq' }, lines: [{ who: 'flight', text: 'Through max Q. Peak aerodynamic stress is behind you.' }] },
  { trigger: { on: 'staging' }, lines: [{ who: 'capcom', text: 'Staging confirmed. Good ignition.' }] },
  { trigger: { on: 'space' }, lines: [{ who: 'capcom', text: 'You\'ve crossed the Kármán line. Welcome to space.' }] },
  { trigger: { on: 'orbit' }, lines: [{ who: 'capcom', text: 'Engine cut-off. Periapsis is clear of the atmosphere — you\'re in orbit.' }] },
  { trigger: { on: 'soi', body: 'moon' }, lines: [{ who: 'capcom', text: 'You\'re inside the Moon\'s sphere of influence. Its gravity is in charge now.' }] },
  { trigger: { on: 'soi', body: 'mars' }, lines: [{ who: 'flight', text: 'Mars sphere of influence. After the long cruise, she\'s all yours.' }] },
  { trigger: { on: 'soi', body: 'sun' }, lines: [{ who: 'capcom', text: 'You\'ve left Earth\'s sphere of influence. You\'re in orbit around the Sun.' }] },
  { trigger: { on: 'los' }, lines: [{ who: 'capcom', text: 'Loss of signal in a few seconds as you pass behind the Moon. See you on the other side.' }], once: false },
  { trigger: { on: 'aos' }, lines: [{ who: 'capcom', text: 'Acquisition of signal. Good to hear you again.' }], once: false },
  { trigger: { on: 'reentry' }, lines: [{ who: 'capcom', text: 'You\'re entering blackout — the plasma around you will block the radio. Talk soon.' }] },
  { trigger: { on: 'chute' }, lines: [{ who: 'capcom', text: 'Chutes out. Nice and slow.' }] },
  { trigger: { on: 'landed', body: 'moon' }, lines: [{ who: 'flight', text: 'Contact! Engines off. You\'re on the Moon.' }] },
  { trigger: { on: 'landed', body: 'mars' }, lines: [{ who: 'flight', text: 'Touchdown on Mars confirmed!' }] },
  { trigger: { on: 'highg' }, lines: [{ who: 'capcom', text: 'We\'re reading seven g on the crew. Ease off if you can — they\'re greying out.' }] },
  { trigger: { on: 'rendezvous' }, lines: [{ who: 'capcom', text: 'Inside five hundred metres. Kill the relative velocity and take it slow from here — RCS only.' }] },
  { trigger: { on: 'docked' }, lines: [{ who: 'capcom', text: 'Capture confirmed — hard dock. Two vehicles, one spacecraft.' }] },
  { trigger: { on: 'undocked' }, lines: [{ who: 'capcom', text: 'Undocking confirmed. Back away gently before any main-engine burn.' }], once: false },
];

export const STORY: Record<string, MissionStory> = {
  'first-light': {
    brief: [
      { who: 'flight', text: 'Ray Castillo, flight director. Today\'s objective is simple: get Pathfinder above ten kilometres.' },
      { who: 'engineer', text: 'Stage once to light the solid motor. It burns for about a minute and can\'t be throttled or shut off — after that, it\'s a coast.' },
    ],
    radio: [
      { trigger: { on: 'start' }, lines: [{ who: 'capcom', text: 'Pathfinder, all stations report go. Stage when ready.' }] },
      { trigger: { on: 'objective', index: 1 }, lines: [{ who: 'flight', text: 'Ten kilometres. You\'re above most of the weather — and a quarter of the atmosphere.' }] },
    ],
    success: [{ who: 'director', text: 'Small rocket, perfect flight. The board watched the telemetry live. Let\'s go higher.' }],
    failure: [{ who: 'flight', text: 'Every program has days like this. Reset the pad — we fly again.' }],
  },
  karman: {
    brief: [
      { who: 'flight', text: 'Next stop: the Kármán line, 100 kilometres up. The edge of space.' },
      { who: 'engineer', text: 'Going up is half the job. The probe falls back at over a kilometre per second. Stage the parachute only once the air has slowed you — below about ten kilometres — or it will shred.' },
    ],
    radio: [
      { trigger: { on: 'descending', km: 15, body: 'earth' }, lines: [{ who: 'capcom', text: 'Fifteen kilometres and falling. Stand by to deploy the chute.' }] },
    ],
    success: [
      { who: 'director', text: 'Our first trip to space and our first recovery. Engineering gets to take the probe apart tomorrow.' },
      { who: 'news', text: 'ORBITAL NEWS: Newcomer APOGEE reaches space on its second launch. Industry watchers are taking notice.' },
    ],
    failure: [{ who: 'engineer', text: 'Either the chute opened too fast or not at all. Wait for the dynamic pressure to drop before staging it.' }],
  },
  orbit: {
    brief: [
      { who: 'engineer', text: 'Orbit isn\'t about height — it\'s about speed. About 7.8 km/s sideways, so you fall around the Earth instead of into it.' },
      { who: 'flight', text: 'Fly a gravity turn: start leaning east early and burn horizontally near apoapsis. The flight computer\'s ASCENT program can fly it for you.' },
    ],
    radio: [
      { trigger: { on: 'orbit' }, lines: [{ who: 'capcom', text: 'SECO! Periapsis is above the atmosphere. We have a satellite!' }] },
    ],
    success: [{ who: 'director', text: 'The first APOGEE satellite is circling the planet every ninety minutes. The press can wait — the engineers are opening champagne.' }],
    failure: [{ who: 'flight', text: 'Not enough horizontal speed. Pitch over earlier, and keep burning at apoapsis until periapsis clears 140 km.' }],
  },
  'crewed-orbit': {
    brief: [
      { who: 'director', text: 'Kenji flies today. Everything we\'ve learned goes into this one.' },
      { who: 'kenji', text: 'Kestrel is ready. Get me up there and I\'ll bring her home.' },
      { who: 'engineer', text: 'To come home: burn retrograde until periapsis is about 60 km, drop the service module, keep the heat shield forward. Chutes below ten kilometres.' },
    ],
    radio: [
      { trigger: { on: 'start' }, lines: [{ who: 'capcom', text: 'Kestrel, APOGEE Control. All stations are go. Godspeed, Kenji.' }] },
      { trigger: { on: 'liftoff' }, lines: [{ who: 'kenji', text: 'Feels like a freight train! Kestrel is climbing.' }] },
      { trigger: { on: 'orbit' }, lines: [{ who: 'kenji', text: 'Oh… that view. Tell everyone down there it\'s worth it.' }] },
      { trigger: { on: 'reentry' }, lines: [{ who: 'capcom', text: 'Kestrel, you\'re entering blackout. We\'ll hear you on the other side.' }] },
      { trigger: { on: 'chute' }, lines: [{ who: 'kenji', text: 'Mains are out! Three beautiful chutes.' }] },
    ],
    success: [
      { who: 'kenji', text: 'Kestrel is home. Ninety minutes around the world, and I\'d go again tomorrow.' },
      { who: 'director', text: 'We\'re a human spaceflight program now. Helion just moved up their crewed launch by six months.' },
    ],
    failure: [{ who: 'director', text: 'We lost Kestrel. Nobody flies again until we understand exactly why.' }],
  },
  'weather-eye': {
    brief: [
      { who: 'sofia', text: 'A weather satellite needs to see the whole planet. A polar orbit passes over every point on Earth as it turns underneath.' },
      { who: 'engineer', text: 'Launch south from Vandenberg and aim for about 98° inclination — slightly retrograde. Earth\'s equatorial bulge then swings the orbit around once a year: it stays locked to the Sun.' },
      { who: 'flight', text: 'The ascent program is pre-set to a southbound heading. Watch the inclination on the telemetry panel.' },
    ],
    radio: [
      { trigger: { on: 'orbit' }, lines: [{ who: 'capcom', text: 'Polar orbit confirmed. You\'ll cross both poles every ninety-seven minutes.' }] },
    ],
    success: [
      { who: 'sofia', text: 'First images are down: a storm off Iceland and the edge of the Arctic sea ice. The meteorologists are thrilled.' },
      { who: 'news', text: 'ORBITAL NEWS: APOGEE weather satellite enters service; forecasters hail sharper polar data.' },
    ],
    failure: [{ who: 'engineer', text: 'Check the heading and inclination. Polar orbits start by flying south, not east.' }],
  },
  geo: {
    brief: [
      { who: 'director', text: 'A telecom consortium wants a satellite in geostationary orbit. Their contract pays for the Moon program.' },
      { who: 'engineer', text: 'A Hohmann transfer: from a low parking orbit, burn prograde to stretch apoapsis out to 35,786 km. Circularize up there and the satellite keeps pace with the turning Earth.' },
    ],
    radio: [
      { trigger: { on: 'objective', index: 1 }, lines: [{ who: 'capcom', text: 'Apoapsis at geostationary altitude. Coast up, and circularize for the bonus if you have the fuel.' }] },
    ],
    success: [{ who: 'director', text: 'Signal from geostationary orbit, and our first paying customer. The Moon program is funded.' }],
    failure: [{ who: 'flight', text: 'We didn\'t reach GEO altitude. It takes about 2.4 km/s from a low orbit — budget for it.' }],
  },
  'lunar-flyby': {
    brief: [
      { who: 'director', text: 'Helion launched their lunar probe last night. Ours goes today.' },
      { who: 'engineer', text: 'We launch into the lunar window. From parking orbit, the flight computer\'s "To the Moon" burn adds about 3.1 km/s — and you arrive three days later, where the Moon will be then.' },
      { who: 'flight', text: 'Use "Fine-tune" once you\'re coasting to trim the arrival. Time warp is your friend out there.' },
    ],
    radio: [
      { trigger: { on: 'objective', index: 1 }, lines: [{ who: 'capcom', text: 'Trans-lunar coast. You\'re climbing out of Earth\'s gravity well at eleven kilometres per second — and slowing.' }] },
    ],
    success: [
      { who: 'sofia', text: 'Images of the far side, from our own spacecraft. I may have cried a little.' },
      { who: 'news', text: 'ORBITAL NEWS: APOGEE probe reaches the Moon first. Helion\'s craft still circling Earth after an engine fault.' },
    ],
    failure: [{ who: 'engineer', text: 'No encounter. Burn from the lunar window\'s parking orbit, and use the planner — the Moon won\'t wait for us.' }],
  },
  'free-return': {
    brief: [
      { who: 'engineer', text: 'A free-return trajectory: leave Earth so that the Moon\'s gravity swings you around its far side and throws you straight back home — no engine needed to come back.' },
      { who: 'flight', text: 'Apollo flew this way for safety. Plan "To the Moon", then use "Fine-tune" so the Earth periapsis after the flyby ends up below 100 km. Then it\'s a matter of heat shield and patience.' },
      { who: 'sofia', text: 'Skim the far side low and the pictures will be worth the trip.' },
    ],
    radio: [
      { trigger: { on: 'soi', body: 'moon' }, lines: [{ who: 'capcom', text: 'Inside the Moon\'s sphere of influence. Watch the predicted trajectory swing — the Moon is doing the work now.' }] },
      { trigger: { on: 'objective', index: 2 }, lines: [{ who: 'flight', text: 'Earth periapsis under a hundred kilometres. That\'s a free return — gravity brought you home for nothing.' }] },
    ],
    success: [
      { who: 'engineer', text: 'A slingshot around the Moon and a splashdown, on gravity alone. Newton would be pleased.' },
      { who: 'news', text: 'ORBITAL NEWS: APOGEE probe loops the Moon and returns without firing an engine, proving the crew-rescue trajectory.' },
    ],
    failure: [{ who: 'engineer', text: 'The flyby did not bring the periapsis low enough — or brought it too low. Trim early, while a metre per second still moves the Earth periapsis by hundreds of kilometres.' }],
  },
  'relay-net': {
    brief: [
      { who: 'director', text: 'A relay constellation: three satellites, one launch. It pays for the station and it keeps our Moon crews talking.' },
      { who: 'engineer', text: 'The kick stage puts the stack in orbit. Then stage each radial separator by hand and use "[" and "]" to switch between the satellites — each is a spacecraft of its own once it\'s free.' },
      { who: 'flight', text: 'Bonus for spreading them out: switch to a satellite, wait a few minutes, then release the next one.' },
    ],
    radio: [
      { trigger: { on: 'orbit' }, lines: [{ who: 'capcom', text: 'Parking orbit. Deploy the relays when you\'re ready — separators are in the staging list.' }] },
      { trigger: { on: 'objective', index: 1 }, lines: [{ who: 'sofia', text: 'Three relays, three carriers on the ground stations. The network is up.' }] },
    ],
    success: [
      { who: 'director', text: 'The relay network is live. Somebody in accounting just smiled.' },
      { who: 'engineer', text: 'Those satellites stay in orbit between flights now. Check the tracking station.' },
    ],
    failure: [{ who: 'engineer', text: 'A relay is useless below the atmosphere. Get the whole stack to a stable orbit before you release anything.' }],
  },
  keystone: {
    brief: [
      { who: 'priya', text: 'Keystone is my future home. Two docking ports, solar wings, and enough RCS to hold attitude for years. Put it in a clean 400-kilometre orbit.' },
      { who: 'engineer', text: 'The station core replaces the payload on a Heron 9. Circularise between 380 and 420 km; the lower the eccentricity, the easier every future rendezvous.' },
    ],
    radio: [
      { trigger: { on: 'orbit' }, lines: [{ who: 'priya', text: 'Keystone is in orbit. Now trim it — I want that orbit round.' }] },
      { trigger: { on: 'objective', index: 1 }, lines: [{ who: 'capcom', text: 'Keystone is on station. Solar arrays tracking, ports clear.' }] },
    ],
    success: [
      { who: 'priya', text: 'A station in orbit with my name on the crew list. See you up there.' },
      { who: 'news', text: 'ORBITAL NEWS: APOGEE launches Keystone, the first module of a permanent station. Crew flights to follow.' },
    ],
    failure: [{ who: 'engineer', text: 'The core never reached its orbit. Keystone needs a clean, circular 400 km before anyone can meet it.' }],
  },
  handshake: {
    brief: [
      { who: 'priya', text: 'Kenji flies me up to Keystone today. Rendezvous first — we\'ll dock next time.' },
      { who: 'engineer', text: 'Rendezvous is a phasing game. Launch into the station\'s plane, set Keystone as the target, then use "Intercept": the planner waits for the right phase and meets it. At closest approach, "Match velocity" cancels the relative speed.' },
      { who: 'flight', text: 'Inside 200 metres with less than 2 m/s relative and the objective is done. The RCS keys (H/N, I/K, J/L) move you without turning.' },
    ],
    radio: [
      { trigger: { on: 'orbit' }, lines: [{ who: 'kenji', text: 'In orbit. Where\'s our station? … there. Twelve hundred kilometres ahead and climbing away.' }] },
      { trigger: { on: 'rendezvous' }, lines: [{ who: 'priya', text: 'Look at her. She\'s smaller than I imagined and I don\'t care at all.' }] },
    ],
    success: [
      { who: 'kenji', text: 'Station-keeping at a hundred metres. She\'s beautiful, Priya.' },
      { who: 'director', text: 'Two vehicles in formation. Next time we bring them together.' },
    ],
    failure: [{ who: 'engineer', text: 'No rendezvous. Match the plane first, then let the intercept planner do the phasing — it can take a few orbits.' }],
  },
  'hard-dock': {
    brief: [
      { who: 'priya', text: 'This time we go inside. Nose port to Keystone\'s port: line up, close at half a metre a second, and let the latches do the rest.' },
      { who: 'engineer', text: 'Rendezvous as before, then RCS: target the station, hold the nose on the target marker, and creep in. Ports need to be face to face within about fifteen degrees.' },
      { who: 'flight', text: 'Once docked you fly the combined stack. Undock is in the flight computer. Bring the crew home when you\'re done.' },
    ],
    radio: [
      { trigger: { on: 'rendezvous' }, lines: [{ who: 'capcom', text: 'Five hundred metres. Nose on the target, RCS only from here.' }] },
      { trigger: { on: 'docked' }, lines: [{ who: 'priya', text: 'Capture… latches… hard dock! Welcome aboard Keystone.' }] },
      { trigger: { on: 'undocked' }, lines: [{ who: 'priya', text: 'Keystone is holding. Safe trip home, Kenji.' }] },
    ],
    success: [
      { who: 'priya', text: 'The first crew to live on Keystone. The coffee machine is docked; the rest can follow.' },
      { who: 'news', text: 'ORBITAL NEWS: APOGEE crew docks with Keystone station — the agency\'s first permanent foothold in orbit.' },
    ],
    failure: [{ who: 'engineer', text: 'No hard dock. Slower, straighter: under a metre per second and the ports aligned.' }],
  },
  'lunar-orbit': {
    brief: [
      { who: 'flight', text: 'This time we stay. Arriving at the Moon you\'re on a hyperbola — you\'ll fly right past unless you brake.' },
      { who: 'engineer', text: 'At periapsis burn retrograde, about 800 m/s. The planner\'s "Circularize at Pe" computes it for you.' },
    ],
    radio: [
      { trigger: { on: 'objective', index: 1 }, lines: [{ who: 'flight', text: 'Lunar orbit insertion complete. We\'re the second agency ever to orbit the Moon.' }] },
    ],
    success: [{ who: 'sofia', text: 'Mapping has begun. Two landing sites near the south pole look promising.' }],
    failure: [{ who: 'flight', text: 'No capture. The braking burn has to happen near periapsis, and it has to be long enough.' }],
  },
  surveyor: {
    brief: [
      { who: 'engineer', text: 'No air, no parachutes. Every metre per second of fall has to be cancelled with the engine.' },
      { who: 'flight', text: 'From lunar orbit: de-orbit burn, kill horizontal speed, then a gentle final descent. The LAND program flies a suicide-burn profile if you\'d rather watch.' },
    ],
    radio: [
      { trigger: { on: 'descending', km: 2, body: 'moon' }, lines: [{ who: 'capcom', text: 'Two kilometres. Legs down, eyes on vertical speed.' }] },
    ],
    success: [
      { who: 'sofia', text: 'Surveyor is down and talking. Regolith temperature, minus 170 in the shadow of the lander. Perfect.' },
      { who: 'director', text: 'Robots first — done. Now we send people.' },
    ],
    failure: [{ who: 'engineer', text: 'Too fast at contact. Leave more fuel for the last kilometre; the Moon punishes hurry.' }],
  },
  'small-step': {
    brief: [
      { who: 'director', text: 'This is the one. Kenji commands, and the whole world is watching.' },
      { who: 'kenji', text: 'Colossus is the biggest thing we\'ve ever built. I\'d like to bring her back in fewer pieces than she left in.' },
      { who: 'engineer', text: 'Staging order: first stage, second stage to orbit, the third stage does the trans-lunar burn. The descent stage lands you. Budget every second of burn time.' },
    ],
    radio: [
      { trigger: { on: 'start' }, lines: [{ who: 'flight', text: 'All flight controllers: this is it. Go / no-go for launch… we are GO.' }] },
      { trigger: { on: 'soi', body: 'moon' }, lines: [{ who: 'kenji', text: 'The Moon fills the whole window now. It\'s grey, and gold, and huge.' }] },
      { trigger: { on: 'landed', body: 'moon' }, lines: [{ who: 'kenji', text: 'Control, Condor. We\'re down. The dust is settling… it\'s the most beautiful desert I\'ve ever seen.' }] },
    ],
    success: [
      { who: 'director', text: 'People on the Moon, again — and this time, to stay. Thank you, all of you.' },
      { who: 'news', text: 'ORBITAL NEWS: APOGEE crew lands on the Moon. Helion congratulates its rival and vows to follow.' },
    ],
    failure: [{ who: 'director', text: 'We lost the crew vehicle. Stand everything down. We go again when we know why.' }],
  },
  'home-again': {
    brief: [
      { who: 'flight', text: 'Landing was half the job. This time we bring the crew all the way home.' },
      { who: 'engineer', text: 'After the landing, lift off on the ascent module and plan "Return home" from lunar orbit. You\'ll hit the atmosphere at eleven kilometres per second — keep periapsis between 30 and 50 km or you skip out or burn up.' },
      { who: 'kenji', text: 'Two days out, three days back. I\'ve packed a sandwich.' },
    ],
    radio: [
      { trigger: { on: 'landed', body: 'moon' }, lines: [{ who: 'flight', text: 'Surface operations begin. When you\'re ready, we\'ll get you home.' }] },
      { trigger: { on: 'soi', body: 'earth' }, lines: [{ who: 'capcom', text: 'Welcome back into Earth\'s sphere of influence. Check your entry periapsis.' }] },
      { trigger: { on: 'reentry' }, lines: [{ who: 'kenji', text: 'Here comes the fire. See you in four minutes.' }] },
      { trigger: { on: 'chute' }, lines: [{ who: 'capcom', text: 'We have you back! Main chutes, three good chutes!' }] },
    ],
    success: [
      { who: 'kenji', text: 'Splashdown. Somebody please open the hatch — the Earth smells amazing.' },
      { who: 'director', text: 'A complete lunar mission, there and back. Next stop: Mars.' },
    ],
    failure: [{ who: 'flight', text: 'The crew didn\'t make it home. We review every second of the flight before anyone goes again.' }],
  },
  'mars-transfer': {
    brief: [
      { who: 'director', text: 'The Mars window is open. Our first interplanetary probe, Ares, launches today.' },
      { who: 'engineer', text: 'From parking orbit, "To Mars" plans the injection — about 3.6 km/s. That puts Ares on a transfer ellipse around the Sun that meets Mars eight to twelve months from now.' },
      { who: 'flight', text: 'After leaving Earth\'s sphere, use "Fine-tune" to trim the Mars approach — small corrections early are cheap, late ones are expensive.' },
    ],
    radio: [
      { trigger: { on: 'soi', body: 'sun' }, lines: [{ who: 'flight', text: 'Ares is in orbit around the Sun. Warp ahead — it\'s a long cruise.' }] },
    ],
    success: [
      { who: 'sofia', text: 'Ares is at Mars. After months in the dark, it just opened its eyes on another planet.' },
      { who: 'news', text: 'ORBITAL NEWS: APOGEE\'s Ares probe arrives at Mars — the agency\'s first interplanetary mission.' },
    ],
    failure: [{ who: 'engineer', text: 'We missed Mars. The injection has to happen in the window, then trim early with a correction burn.' }],
  },
  'mars-orbit': {
    brief: [
      { who: 'sofia', text: 'Now we stay. An orbiter maps landing sites and relays data from future landers.' },
      { who: 'engineer', text: 'Same trick as the Moon, bigger numbers: brake at periapsis. A loose elliptical capture costs far less than a circular orbit.' },
    ],
    radio: [
      { trigger: { on: 'objective', index: 2 }, lines: [{ who: 'flight', text: 'Mars orbit insertion confirmed. Ares is now a satellite of Mars.' }] },
    ],
    success: [{ who: 'sofia', text: 'First orbital images: Valles Marineris at sunrise. It\'s four thousand kilometres long. I need a minute.' }],
    failure: [{ who: 'engineer', text: 'No capture — the braking burn was too short or too late. Plan it with "Circularize at Pe".' }],
  },
  'mars-landing': {
    brief: [
      { who: 'engineer', text: 'Seven minutes from the top of the atmosphere to the ground, and we can\'t help: the radio delay is longer than the landing.' },
      { who: 'flight', text: 'Aim the approach periapsis low, around 40 km. The heat shield sheds most of the speed, the parachute does its best in thin air, then the engine finishes the job on the legs.' },
      { who: 'sofia', text: 'Jezero, Gale, Utopia — anywhere flat. Just get it down in one piece.' },
    ],
    radio: [
      { trigger: { on: 'descending', km: 60, body: 'mars' }, lines: [{ who: 'capcom', text: 'Entry interface. Heat shield is taking the load.' }] },
      { trigger: { on: 'descending', km: 8, body: 'mars' }, lines: [{ who: 'capcom', text: 'Eight kilometres. Parachute when you\'re slow enough.' }] },
    ],
    success: [
      { who: 'director', text: 'A lander on Mars. Twenty minutes ago it happened; eleven minutes ago we found out. Congratulations, everyone.' },
      { who: 'news', text: 'ORBITAL NEWS: APOGEE lands on Mars. "The next footprints there will be human," says Director Okafor.' },
    ],
    failure: [{ who: 'engineer', text: 'Mars is the hardest place to land in the solar system: too thin to stop you, thick enough to burn you. Try a shallower entry.' }],
  },
};
