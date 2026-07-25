import { describe, expect, test } from 'bun:test'

import detectTextLanguage from '#helpers/utils/detectTextLanguage'

/**
 * Language-of-a-blurb detection, which exists for exactly one reason: Apple
 * Books returns NO language field, and lists localized editions under the
 * ORIGINAL title. Both fixtures below are the real iTunes descriptions of the
 * two "Babel" audiobooks (ids 1596509362 and 1729551786) — same title, same
 * author, same store, different language — and before this the scorer had
 * nothing to tell them apart.
 */

// Verbatim from the iTunes Search API, HTML stripped.
const BABEL_EN =
	'From award-winning author R. F. Kuang comes Babel, a thematic response to The ' +
	'Secret History and a tonal retort to Jonathan Strange & Mr. Norrell that grapples ' +
	'with student revolutions, colonial resistance, and the use of language and ' +
	'translation as the dominating tool of the British empire.'

const BABEL_ES =
	'1828. El Instituto Real de Traducción de Oxford, también conocido como Babel, es la ' +
	'institución mágica más importante del mundo. La magia con plata capaz de revelar ' +
	'significados ocultos perdidos en la traducción que allí se practica le ha otorgado ' +
	'al Imperio británico un poder sin parangón.'

describe('detectTextLanguage', () => {
	test('separates the two real "Babel" editions', () => {
		expect(detectTextLanguage(BABEL_EN)).toBe('en')
		expect(detectTextLanguage(BABEL_ES)).toBe('es')
	})

	test('recognises the other languages Apple actually serves', () => {
		expect(
			detectTextLanguage(
				'Der Roman ist ein Meisterwerk der deutschen Literatur und wurde von der Kritik ' +
					'gefeiert. Das Buch erzählt die Geschichte eines Mannes, der sich nicht mit dem ' +
					'Schicksal abfinden will und auch nicht mit den Regeln der Gesellschaft.'
			)
		).toBe('de')
		expect(
			detectTextLanguage(
				"Les aventures d'un jeune homme dans les rues de Paris, qui ne pas se laisse pas " +
					'faire par les puissants de cette ville, avec une plume qui est aussi vive que ' +
					'drôle, pour tout lecteur qui aime les grands romans.'
			)
		).toBe('fr')
	})

	test('REGRESSION: Italian is not English', () => {
		// The first version excluded "a"/"in" from the Italian list to stop English
		// scoring as Italian, which inverted the problem: Italian prose scored
		// en=6 (its own "a" and "in") against it=1 and returned 'en'. That both
		// defeated the feature and, in an it-region library, demoted the CORRECT
		// edition. AppleBooksProvider's header names the Italian "Project Hail
		// Mary" as the motivating case, so this is the one language that mattered.
		expect(
			detectTextLanguage(
				'Un romanzo che racconta la storia di un uomo in cerca di se stesso, in una ' +
					'citta che non perdona. La scrittura e limpida e il ritmo incalzante, con ' +
					'personaggi che restano a lungo nella memoria del lettore. Il libro ha vinto ' +
					'numerosi premi ed e stato tradotto in venti lingue diverse.'
			)
		).toBe('it')
	})

	test('accented prose matches the ASCII tables', () => {
		// Tokens are folded before lookup, so the tables stay ASCII. Without the
		// fold a bare "nao" could never match real Portuguese, which always
		// tokenizes with the tilde -- one dead entry, invisible because the rest
		// still summed to a plausible score.
		expect(
			detectTextLanguage(
				'Um romance sobre a vida de uma familia em Lisboa, a cidade que não dorme. ' +
					'A autora constrói personagens densos e uma trama que prende o leitor até à ' +
					'última página, e que não se esquece depois de terminada a leitura.'
			)
		).toBe('pt')
		expect(
			detectTextLanguage(
				'Un romanzo che racconta la storia di un uomo in cerca di sé stesso, in una ' +
					'città che non perdona. La scrittura è limpida e il ritmo è incalzante, con ' +
					'personaggi che restano a lungo nella memoria del lettore e più ancora.'
			)
		).toBe('it')
	})

	test('a tagline is too short to judge — returns null, not a guess', () => {
		// 18 of 1,413 live summaries fall under the token floor. Guessing on those
		// would risk demoting a legitimate edition on a handful of tokens.
		expect(detectTextLanguage('A gripping thriller.')).toBeNull()
		expect(detectTextLanguage('El libro del año.')).toBeNull()
	})

	test('empty, null and undefined are null', () => {
		expect(detectTextLanguage('')).toBeNull()
		expect(detectTextLanguage(null)).toBeNull()
		expect(detectTextLanguage(undefined)).toBeNull()
	})

	test('a stray foreign word in English prose does not flip it', () => {
		// The expensive error is a FALSE foreign label: it would demote a real
		// English edition by LANGUAGE_CONFLICT_PENALTY. Spanish place names and
		// German surnames appear in English blurbs constantly.
		const english =
			'The story begins in El Paso, where the young detective von Hoffman is called to ' +
			'investigate a death at the Casa del Sol hotel, and the trail leads him from the ' +
			'border to the mountains and back again before the truth is finally revealed.'
		expect(detectTextLanguage(english)).toBe('en')
	})

	test('text with no function words at all yields null', () => {
		// Long enough to pass the token floor, but nothing to classify on.
		expect(detectTextLanguage(Array(40).fill('lorem').join(' '))).toBeNull()
	})
})
