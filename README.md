# Lustro rentgenowskie

Aplikacja w przeglądarce: obraz z kamery albo nagranie z pliku, a na nim szkielet, mięśnie, narządy, naczynia i mózg, które idą za ruchem ciała. Struktury mają podpisy po polsku. Obraz przetwarza Twój komputer, nic nie jest wysyłane do sieci.

## Co jest potrzebne

- Node.js w wersji 18 albo nowszej (https://nodejs.org),
- przeglądarka Chrome albo Edge,
- kamera w komputerze albo nagranie wideo z osobą w kadrze.

## Uruchomienie

```bash
git clone https://github.com/Maksym993/lustro-rentgenowskie.git
cd lustro-rentgenowskie
npm install
npm run dev
```

Potem otwórz http://localhost:5184 w Chrome. Kamera działa tylko pod adresem localhost. Komenda `npm run dev` nie kończy się sama: aplikacja działa, dopóki ona chodzi w terminalu. Zamyka ją Ctrl+C.

Modele śledzenia, pliki wasm i model anatomiczny są w repozytorium, więc po `npm install` aplikacja nie potrzebuje sieci.

## Pierwsze kroki

1. Kliknij „Włącz kamerę” i pozwól przeglądarce na dostęp do kamery albo wybierz „Wczytaj nagranie”.
2. Stań tak, żeby było widać głowę i barki. Im więcej ciała w kadrze, tym więcej anatomii.
3. W zakładce Warstwy włącz to, co chcesz oglądać: kości, mięśnie, narządy, naczynia, mózg, oczy, obrys ciała.
4. W zakładce Odsłona wybierz „Soczewka w dłoni”: anatomię widać wtedy tylko w kole, które idzie za dłonią. Palce zebrane w punkt zmniejszają koło, otwarta dłoń je powiększa.

## Interfejs

- Górny pasek: źródło obrazu (kamera albo plik, stopklatka, pauza i przewijanie) oraz zapis (zdjęcie, nagrywanie, eksport, pełny ekran).
- Szyna po lewej z zakładkami: Warstwy, Części ciała, Odsłona, Obraz, Głowa, Zapis, Kontrola. Kliknięcie otwartej zakładki chowa panel.
- Pasek stanu na dole: lampki twarzy, sylwetki i dłoni (czy śledzenie je widzi), tempo i źródło.
- Skróty: spacja (stopklatka albo pauza), S (zdjęcie), R (nagrywanie), P (podpisy), F (pełny ekran), H (panel), 1 do 7 (warstwy).

## Co potrafi

- Źródło: kamera (z lustrem) albo plik wideo (bez lustra, z pauzą i przewijaniem).
- Warstwy: kości, mięśnie, narządy, naczynia, mózg, oczy, obrys ciała. Gotowe zestawy jednym kliknięciem.
- Wygląd: rentgen (przezroczyste, świecące krawędzie) albo bryła (oświetlony model).
- Części ciała: na sylwetce w panelu zaznacza się dowolne fragmenty (głowa, szyja, klatka piersiowa, brzuch, miednica, osobno ramię, przedramię, dłoń, udo, goleń i stopa z każdej strony). Anatomia i podpisy zostają tylko na zaznaczonych.
- „Ile mnie widać”: jak mocno prawdziwy obraz zostaje pod anatomią.
- Odsłona: całe ciało, tylko lewa albo prawa połowa, tylko góra albo dół, soczewka, która idzie za dłonią.
- Podpisy zmieniają się z odległością: z daleka „Czaszka” i „Kręgosłup”, w zbliżeniu kości czaszki, płaty mózgu, mięśnie twarzy, kości nadgarstka. Wielkość liter i liczbę podpisów ustawia się w zakładce Warstwy.
- Żuchwa otwiera się razem z ustami, kość promieniowa obraca się przy nawracaniu przedramienia, palce zginają się kość po kości.
- Model sylwetki (zakładka Obraz): Auto, Szybki albo Dokładny. Dokładny rzadziej gubi ręce i nogi przy szybkim ruchu, ale liczy klatkę dłużej. W trybie Auto program sam wraca do szybkiego, gdy komputer nie nadąża.
- Nagrywanie gotowego obrazu na żywo do pliku (MP4, a gdy przeglądarka nie umie, WebM), opcjonalnie z dźwiękiem.
- „Eksportuj całe nagranie” przy pliku wideo: film jest przeliczany klatka po klatce (30 kl./s) i zapisywany jako MP4 z dźwiękiem z oryginału. Wymaga Chrome albo Edge (WebCodecs).
- Zdjęcie bieżącego obrazu (PNG), stopklatka obrazu z kamery i odliczanie 3 sekund przed nagraniem.
- Kadr poziomy 16:9 albo pionowy 9:16, 1080p albo 720p.

## Ograniczenia

- Anatomia to model jednej osoby przeskalowany do sylwetki z kamery. Pokazuje, gdzie zwykle leżą struktury. To nie jest skan ani narzędzie medyczne.
- Śledzi jedną osobę. Przy osobie odwróconej tyłem głowa ustawia się z punktów sylwetki, mniej dokładnie niż z twarzy.
- Głębia z jednej kamery jest przybliżona. Kość ustawiona wprost do obiektywu rysuje się jak leżąca w płaszczyźnie obrazu.
- Bardzo szybkie ruchy dłoni model dłoni gubi na kilka klatek.
- W słabym świetle kamera rozmazuje szybkie ruchy i anatomia odstaje wtedy od ręki. Pomaga doświetlenie pokoju.
- Języka aplikacja nie śledzi.

## Jak to działa

1. `src/main.js`: bieżąca klatka obrazu trafia na płótno. Z tej samej kopii korzysta śledzenie i wyświetlanie, więc anatomia nie jest liczona z innej klatki niż ta, którą widać.
2. `src/sledzenie.js`: MediaPipe liczy sylwetkę (33 punkty), twarz (478 punktów) i dłonie (2 x 21 punktów).
3. `src/straznik.js`, `src/dlonie.js`, `src/bufor.js`: kontrole i wygładzanie tego, co oddało śledzenie. Obraz wychodzi o 2 klatki później, a w zamian anatomia jest liczona z klatek po obu stronach tej, którą widać.
4. `src/rig.js`: z punktów powstaje macierz dla każdej z 56 kości.
5. `src/scena.js`: three.js rysuje warstwy anatomii i składa je z obrazem. `src/etykiety.js` dokłada podpisy.
6. `src/eksport.js`: eksport nagrania klatka po klatce przez koder H.264 przeglądarki.

## Model anatomiczny

Gotowy model leży w `public/anatomia` i nie trzeba go budować. Powstał z danych BodyParts3D 3.0. Kto chce zmienić podpisy albo podział na warstwy, pobiera pliki STL BodyParts3D 3.0 do `surowe/bp3d-3.0` (ok. 1,2 GB) oraz wzorcową twarz MediaPipe (`canonical_face_model.obj`) do `surowe/mediapipe`, uruchamia `node narzedzia/indeks.mjs`, a potem `npm run anatomia` (ok. 2 minut). Podpisy są w `narzedzia/etykiety.mjs`, podział na warstwy w `narzedzia/klasy.mjs`.

## Źródła i licencje

- Model anatomiczny (`public/anatomia`): opracowanie danych BodyParts3D, © The Database Center for Life Science, licencja CC BY-SA 2.1 Japan (https://creativecommons.org/licenses/by-sa/2.1/jp/). Ten podpis musi zostać przy publikacji obrazu z aplikacji.
- Modele śledzenia (`public/modele`) i pliki wasm (`public/wasm`): MediaPipe, licencja Apache 2.0.
- Biblioteki: three.js i mp4-muxer (MIT).
