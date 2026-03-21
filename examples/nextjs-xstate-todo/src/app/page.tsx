export default async function Homepage() {
  return (
    <a href={`/lists/${crypto.randomUUID()}`}>
      <button>New List</button>
    </a>
  );
}
