import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/cloudflare";
import { json, Link, useLoaderData, useNavigate } from "@remix-run/react";
import { useCallback } from "react";
import { SessionContext } from "~/session.context";

export const meta: MetaFunction = () => {
  return [
    { title: "Remix + ActorKit Todo" },
    {
      name: "description",
      content: "Welcome to Remix! Using Vite and Cloudflare Workers!",
    },
  ];
};

export const loader = async (_args: LoaderFunctionArgs) => {
  const listId = crypto.randomUUID();
  return json({ listId });
};

export default function Homepage() {
  const { listId } = useLoaderData<typeof loader>();
  const sendSession = SessionContext.useSend();
  const navigate = useNavigate();
  const listIds = SessionContext.useSelector((state) => state.public.listIds);

  const handleNewList = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      sendSession({ type: "NEW_LIST", listId });
      navigate(`/lists/${listId}`);
    },
    [sendSession, listId, navigate]
  );

  return (
    <div>
      <h1>Your Todo Lists</h1>
      {listIds.length > 0 ? (
        <ul>
          {listIds.map((id) => (
            <li key={id}>
              <Link to={`/lists/${id}`}>Todo List {id.slice(0, 8)}</Link>
            </li>
          ))}
        </ul>
      ) : (
        <p>You don't have any todo lists yet.</p>
      )}
      <Link to={`/lists/${listId}`} onClick={handleNewList}>
        <button>New List</button>
      </Link>
    </div>
  );
}
