father(orville, abe).
father(abe, homer).
father(homer, bart).
father(homer, lisa).

parent(X, Y) :- father(X, Y).
grandfather(X, Y) :- father(X, Z), parent(Z, Y).
