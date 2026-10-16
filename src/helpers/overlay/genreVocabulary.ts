/**
 * The approved genre vocabulary for the book-enrichment overlay: the only names
 * an overlay entry may serve as genres.
 *
 * Approved by the operator 2026-10-16 (audiobooks PLAN-v2 section 4.4,
 * `vocab_v2.json`): 105 names, collapsed from the 182 the library carried, with
 * near-duplicates merged ("Humorous" -> "Humor"), sixteen umbrella containers
 * excluded from per-book lists ("Science Fiction & Fantasy", "Literature &
 * Fiction", "Mystery, Thriller & Suspense", ...) and themes (Magic, Dragons, Fae)
 * left out for now.
 *
 * A CLOSED list on purpose. The provider genre path (namesToGenres) is built for
 * free text and normalises it; an overlay genre is an operator decision, so the
 * loader refuses any name not spelled exactly as it appears here rather than
 * guessing. Adding a name is an operator decision too: edit this list in the
 * same change that first uses it.
 *
 * Genre names are not operator prose, so unlike the overlay data they ship in
 * the public repository.
 */
export const OVERLAY_GENRE_VOCABULARY: ReadonlySet<string> = new Set([
	'20th Century',
	'Adventure',
	'African American',
	'Aliens',
	'Alternate History',
	'Amateur Sleuths',
	'Ancient World',
	'Animals',
	'Anthologies & Short Stories',
	'Biographical Fiction',
	'Biographies & Memoirs',
	'Books & Libraries',
	'Business & Careers',
	"Children's Audiobooks",
	'Christian Fiction',
	'Classics',
	'Comics & Graphic Novels',
	'Coming of Age',
	'Contemporary Fiction',
	'Cozy Mystery',
	'Crime',
	'Cults',
	'Cyberpunk',
	'Dark Fantasy',
	'Death & Grief',
	'Dragons & Mythical Creatures',
	'Drama & Plays',
	'Dystopian',
	'Education',
	'Epic Fantasy',
	'Epic Poetry',
	'Espionage',
	'Essays',
	'Europe',
	'Fairy Tales, Folk Tales & Myths',
	'Family Life',
	'Fantasy',
	'Fantasy Romance',
	'First Contact',
	'Friendship',
	'Genetic Engineering',
	'Hard Science Fiction',
	'Health & Wellness',
	'High Fantasy',
	'Historical Fantasy',
	'Historical Fiction',
	'History',
	'Horror',
	'Humor',
	'International Mystery & Crime',
	'Language & Writing',
	'Legal Thriller',
	'Literary Fiction',
	'Literary History & Criticism',
	'LitRPG',
	'Magical Realism',
	'Medical',
	'Metaphysical & Visionary',
	'Middle Grade',
	'Military Science Fiction',
	'Movie, TV & Video Game Tie-Ins',
	'Mystery',
	'Noir',
	'Paranormal',
	'Personal Development',
	'Philosophy',
	'Poetry',
	'Police Procedurals',
	'Political',
	'Politics & Social Sciences',
	'Popular Culture',
	'Post-Apocalyptic',
	'Private Investigators',
	'Progression Fantasy',
	'Psychological',
	'Psychology',
	'Religion & Spirituality',
	'Religious Fiction',
	'Romance',
	'Sagas',
	'Satire',
	'Science Fiction',
	'Sea Adventures',
	'Serial Killers',
	'Small Town & Rural',
	'Social & Life Skills',
	'Space Exploration',
	'Space Opera',
	'Sports',
	'Steampunk',
	'Superhero',
	'Sword & Sorcery',
	'Technothrillers',
	'Terrorism',
	'Thriller & Suspense',
	'Time Travel',
	'United States',
	'Urban Fantasy',
	'War & Military',
	'Weapons & Warfare',
	'Westerns',
	'Women Sleuths',
	"Women's Fiction",
	'World Literature',
	'Young Adult'
])

/**
 * The umbrella containers the vocabulary excludes from per-book lists (PLAN-v2
 * 4.4). Kept beside the list so a test can prove none of them slipped into it:
 * these are exactly the names a hand-edit is most likely to re-add.
 */
export const OVERLAY_GENRE_CONTAINERS: readonly string[] = [
	'Action & Adventure',
	'Arts & Entertainment',
	'Collections',
	'Difficult Discussions',
	'Difficult Situations',
	'Explore the World',
	'Genre Fiction',
	'Geography & Cultures',
	'Holidays',
	'Literature & Fiction',
	'Mystery, Thriller & Suspense',
	'Novella',
	'Science Fiction & Fantasy',
	'Speculative Fiction',
	'Themes & Styles',
	'Women'
]
