module Languages exposing (Model, Msg(..), initial, refresh, update, view)

import Dict exposing (Dict)
import Html exposing (..)
import Html.Attributes exposing (attribute, class, disabled, href, id, rel, style, target, title, value)
import Html.Events exposing (onClick, onInput)
import Http
import Json.Decode as D
import Lingo.Date as Date
import Lingo.Lang exposing (Lang(..))
import Lingo.Theme exposing (Theme)
import Url


type alias Person =
    { id : String, name : String }


type alias Device =
    { id : String, label : String, person : String }


type alias Snapshot =
    { seconds : Float
    , languages : Dict String Float
    , timezone : String
    , dates : List String
    , people : List Person
    , devices : List Device
    }


type alias Model =
    { snapshot : Maybe Snapshot
    , person : String
    , device : String
    , days : String
    , comparison : String
    , generation : Int
    , loading : Bool
    , error : String
    , people : List Person
    , devices : List Device
    , reviewOpen : Bool
    , review : Maybe Review
    , reviewLoading : Bool
    , reviewError : String
    , reviewGeneration : Int
    }


type alias ReviewVideo =
    { videoId : String, title : String, channel : String, seconds : Float, source : String, conf : String }


type alias Review =
    { videos : List ReviewVideo, count : Int, page : Int, pages : Int }


type Msg
    = SetPerson String
    | SetDevice String
    | SetDays String
    | Compare String
    | Refresh
    | Loaded Int (Result Http.Error Snapshot)
    | ToggleReview
    | ReviewPage Int
    | ReviewLoaded Int (Result Http.Error Review)


initial : Model
initial =
    { snapshot = Nothing, person = "", device = "", days = "7", comparison = "de", generation = 0, loading = False, error = "", people = [], devices = [], reviewOpen = False, review = Nothing, reviewLoading = False, reviewError = "", reviewGeneration = 0 }


decoder : D.Decoder Snapshot
decoder =
    D.map6 Snapshot
        (D.field "seconds" D.float)
        (D.field "languages" (D.dict D.float))
        (D.field "timezone" D.string)
        (D.field "daily" (D.list (D.field "date" D.string)))
        (D.field "people" (D.list (D.map2 Person (D.field "id" D.string) (D.field "name" D.string))))
        (D.field "devices" (D.list (D.map3 Device (D.field "id" D.string) (D.field "label" D.string) (D.field "personId" (D.nullable D.string |> D.map (Maybe.withDefault ""))))))


refresh : Model -> ( Model, Cmd Msg )
refresh model =
    let
        next =
            { model | generation = model.generation + 1, loading = True, error = "" }
    in
    ( next
    , Http.request
        { method = "GET", headers = [], body = Http.emptyBody, timeout = Just 10000, tracker = Nothing
        , url = "/api/languages?days=" ++ next.days ++ "&person=" ++ Url.percentEncode next.person ++ "&device=" ++ Url.percentEncode next.device
        , expect = Http.expectJson (Loaded next.generation) decoder
        }
    )


loadReview : Int -> Model -> ( Model, Cmd Msg )
loadReview page model =
    let
        next =
            { model | reviewLoading = True, reviewError = "", reviewGeneration = model.reviewGeneration + 1 }

        videoDecoder =
            D.map6 ReviewVideo (D.field "videoId" D.string) (D.field "title" D.string) (D.field "channel" (D.nullable D.string |> D.map (Maybe.withDefault ""))) (D.field "seconds" D.float) (D.field "source" D.string) (D.field "conf" D.string)

        reviewDecoder =
            D.map4 Review (D.field "videos" (D.list videoDecoder)) (D.field "count" D.int) (D.field "page" D.int) (D.field "pages" D.int)
    in
    ( next
    , Http.request
        { method = "GET", headers = [], body = Http.emptyBody, timeout = Just 10000, tracker = Nothing
        , url = "/api/language-videos?days=" ++ next.days ++ "&person=" ++ Url.percentEncode next.person ++ "&device=" ++ Url.percentEncode next.device ++ "&page=" ++ String.fromInt page
        , expect = Http.expectJson (ReviewLoaded next.reviewGeneration) reviewDecoder
        }
    )


changeScope : Model -> ( Model, Cmd Msg )
changeScope model =
    let
        ( next, cmd ) =
            refresh { model | snapshot = Nothing, review = Nothing, reviewGeneration = model.reviewGeneration + 1 }

        ( reviewed, reviewCmd ) =
            if next.reviewOpen then
                loadReview 1 next

            else
                ( next, Cmd.none )
    in
    ( reviewed, Cmd.batch [ cmd, reviewCmd ] )


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        SetPerson person ->
            changeScope { model | person = person, device = "" }

        SetDevice device ->
            changeScope { model | device = device }

        SetDays days ->
            changeScope { model | days = days }

        ToggleReview ->
            if model.reviewOpen then
                ( { model | reviewOpen = False }, Cmd.none )

            else
                loadReview 1 { model | reviewOpen = True }

        ReviewPage page ->
            loadReview page model

        ReviewLoaded generation result ->
            if generation /= model.reviewGeneration then
                ( model, Cmd.none )

            else
                case result of
                    Ok review ->
                        ( { model | review = Just review, reviewLoading = False }, Cmd.none )

                    Err _ ->
                        ( { model | reviewLoading = False, reviewError = "Could not load the videos. Try again." }, Cmd.none )

        Compare language ->
            ( { model | comparison = language }, Cmd.none )

        Refresh ->
            if model.loading then
                ( model, Cmd.none )

            else
                refresh model

        Loaded generation result ->
            if generation /= model.generation then
                ( model, Cmd.none )

            else
                case result of
                    Ok snapshot ->
                        ( { model | snapshot = Just snapshot, loading = False, error = "", people = snapshot.people, devices = snapshot.devices }, Cmd.none )

                    Err _ ->
                        ( { model | loading = False, error = "Could not load the language breakdown. Try refreshing." }, Cmd.none )


languageName : String -> String
languageName language =
    case language of
        "de" ->
            "German"

        "en" ->
            "English"

        "bcs" ->
            "Bosnian / Croatian / Serbian"

        "es" ->
            "Spanish"

        "other" ->
            "Other / undetermined"

        "und" ->
            "Undetermined"

        "" ->
            "Undetermined"

        _ ->
            String.toUpper language


languageColor : Theme -> String -> String
languageColor theme language =
    theme.fill
        (case language of
            "de" ->
                De

            "en" ->
                En

            "bcs" ->
                Bcs

            "es" ->
                Es

            _ ->
                Other
        )


percentage : Float -> Float -> Float
percentage total seconds =
    if total > 0 then
        seconds / total * 100

    else
        0


percentLabel : Float -> Float -> String
percentLabel total seconds =
    if total > 0 then
        String.fromFloat (toFloat (round (percentage total seconds * 10)) / 10) ++ "%"

    else
        "—"


view : (Float -> String) -> Theme -> Model -> Html Msg
view duration theme model =
    let
        snapshot =
            model.snapshot

        people =
            model.people

        devices =
            model.devices

        matchesPerson device =
            model.person == "" || device.person == model.person || (model.person == "unassigned" && device.person == "")

        rangeButton days =
            button [ onClick (SetDays days), attribute "aria-pressed" (bool (model.days == days)), disabled model.loading ] [ text (days ++ " days") ]
    in
    div [ class "language-content" ]
        [ div [ class "spread wrap language-heading" ]
            [ div [] [ span [ class "eyebrow" ] [ text "A different lens on your viewing" ], h2 [] [ text "Your language mix" ] ]
            , p [ class "micro muted" ] [ text "Separate filters · same recorded playback" ]
            ]
        , div [ class "spread wrap scope-toolbar" ]
            [ div [ class "toolbar" ]
                [ select [ id "language-person-filter", value model.person, onInput SetPerson, disabled model.loading, attribute "aria-label" "Language breakdown person" ]
                    (option [ attribute "value" "", Html.Attributes.selected (model.person == "") ] [ text "All people" ] :: option [ attribute "value" "unassigned", Html.Attributes.selected (model.person == "unassigned") ] [ text "Unassigned devices" ] :: List.map (\person -> option [ attribute "value" person.id, Html.Attributes.selected (model.person == person.id) ] [ text person.name ]) people)
                , select [ id "language-device-filter", value model.device, onInput SetDevice, disabled model.loading, attribute "aria-label" "Language breakdown device" ]
                    (option [ attribute "value" "", Html.Attributes.selected (model.device == "") ] [ text "All this person’s devices" ] :: List.map (\device -> option [ attribute "value" device.id, Html.Attributes.selected (model.device == device.id) ] [ text device.label ]) (List.filter matchesPerson devices))
                ]
            , div [ class "toolbar" ]
                [ div [ class "range-buttons", attribute "aria-label" "Language breakdown date range" ] (List.map rangeButton [ "7", "30", "90" ])
                , button [ class "button", id "language-refresh", onClick Refresh, disabled model.loading ] [ text "Refresh" ]
                ]
            ]
        , if model.error == "" then
            text ""

          else
            p [ class "error", attribute "role" "alert" ] [ text model.error ]
        , case snapshot of
            Nothing ->
                p [ class "card empty muted", attribute "role" "status" ]
                    [ text
                        (if model.loading then
                            "Loading language breakdown…"

                         else
                            "Refresh to load the recorded language estimates."
                        )
                    ]

            Just data ->
                breakdown duration theme model data
        , section [ class "card language-review" ]
            [ div [ class "spread wrap" ]
                [ div [] [ h3 [] [ text "Undetermined videos" ], p [ class "muted micro" ] [ text "Review videos with undetermined or other-language watch segments. Uses the filters above." ] ]
                , button [ id "language-review-toggle", onClick ToggleReview, attribute "aria-expanded" (bool model.reviewOpen), attribute "aria-controls" "language-review-list" ] [ text (if model.reviewOpen then "Hide videos" else "Review undetermined videos") ]
                ]
            , if model.reviewOpen then
                reviewView duration model

              else
                text ""
            ]
        ]


reviewView : (Float -> String) -> Model -> Html Msg
reviewView duration model =
    div [ id "language-review-list", attribute "aria-busy" (bool model.reviewLoading) ]
        [ if model.reviewLoading then
            p [ class "muted", attribute "role" "status" ] [ text "Loading videos…" ]

          else
            text ""
        , if model.reviewError /= "" then
            div [] [ p [ class "error", attribute "role" "alert" ] [ text model.reviewError ], button [ onClick (ReviewPage 1) ] [ text "Try again" ] ]

          else
            text ""
        , case model.review of
            Nothing ->
                text ""

            Just review ->
                div []
                    [ p [ class "muted micro" ] [ text (String.fromInt review.count ++ " videos · sorted by undetermined watch time. A video can also have identified-language segments.") ]
                    , if List.isEmpty review.videos then
                        p [ id "language-review-empty", class "muted" ] [ text "No undetermined videos in this selection." ]

                      else
                        ul [ class "review-videos" ]
                            (List.map
                                (\video ->
                                    li [ class "review-video" ]
                                        [ div []
                                            [ a [ href ("https://www.youtube.com/watch?v=" ++ Url.percentEncode video.videoId), target "_blank", rel "noopener noreferrer", class "review-video-link" ] [ text (if video.title == "" then video.videoId else video.title) ]
                                            , p [ class "muted micro" ] [ text (video.channel ++ " · " ++ video.source ++ " · " ++ video.conf ++ " confidence") ]
                                            ]
                                        , span [ class "review-time" ] [ text (duration video.seconds), small [ class "muted" ] [ text "undetermined / other" ] ]
                                        ]
                                )
                                review.videos
                            )
                    , div [ class "pagination" ]
                        [ button [ onClick (ReviewPage (review.page - 1)), disabled (model.reviewLoading || review.page <= 1) ] [ text "Previous" ]
                        , span [ class "review-page-label" ] [ text ("Page " ++ String.fromInt review.page ++ " of " ++ String.fromInt review.pages) ]
                        , button [ onClick (ReviewPage (review.page + 1)), disabled (model.reviewLoading || review.page >= review.pages) ] [ text "Next" ]
                        , button [ onClick (ReviewPage review.page), disabled model.reviewLoading ] [ text "Refresh list" ]
                        ]
                    ]
        ]


bool : Bool -> String
bool yes =
    if yes then
        "true"

    else
        "false"


breakdown : (Float -> String) -> Theme -> Model -> Snapshot -> Html Msg
breakdown duration theme model snapshot =
    let
        entries =
            Dict.toList snapshot.languages |> List.sortBy (Tuple.second >> negate)

        languages =
            List.foldl (\( code, _ ) choices -> if List.member code choices then choices else choices ++ [ code ]) [ "de", "en", "bcs", "es" ] entries

        selected =
            Dict.get model.comparison snapshot.languages |> Maybe.withDefault 0

        rest =
            max 0 (snapshot.seconds - selected)

        scope =
            snapshot.people
                |> List.filter (\person -> person.id == model.person)
                |> List.head
                |> Maybe.map .name
                |> Maybe.withDefault
                    (if model.person == "unassigned" then
                        "Unassigned devices"

                     else
                        "Everyone"
                    )

        dateRange =
            (List.head snapshot.dates |> Maybe.map Date.short |> Maybe.withDefault "") ++ " to " ++ (List.reverse snapshot.dates |> List.head |> Maybe.map Date.short |> Maybe.withDefault "")

        languageRow ( language, seconds ) =
            tr [ attribute "data-language" language ]
                [ th [ attribute "scope" "row" ] [ span [ class "dot", style "background" (languageColor theme language) ] [], text (languageName language) ]
                , td [ class "language-duration" ] [ text (duration seconds) ]
                , td [ class "language-percentage" ] [ text (percentLabel snapshot.seconds seconds) ]
                , td [ class "language-bar-cell" ]
                    [ div [ class "language-bar", attribute "aria-hidden" "true" ]
                        [ div [ style "width" (String.fromFloat (percentage snapshot.seconds seconds) ++ "%"), style "background" (languageColor theme language) ] [] ]
                    ]
                ]
    in
    div [ class "language-content", attribute "aria-busy" (bool model.loading) ]
        [ div [ class "spread wrap scope-caption" ]
            [ p [ class "muted" ] [ strong [] [ text scope ], text (" · " ++ dateRange ++ " · " ++ snapshot.timezone) ]
            , span [ class "micro muted", attribute "role" "status" ]
                [ text
                    (if model.loading then
                        "Refreshing…"

                     else
                        "Live · refreshes every 15s"
                    )
                ]
            ]
        , section [ class "card language-overview" ]
            [ div [ class "spread wrap" ]
                [ div [] [ span [ class "eyebrow" ] [ text "Playback by language" ], h3 [] [ text "Where your watch time goes" ] ]
                , div [ class "language-total" ] [ strong [ class "figure", id "language-total" ] [ text (duration snapshot.seconds) ], span [ class "micro muted" ] [ text "total recorded playback" ] ]
                ]
            , if snapshot.seconds <= 0 then
                p [ class "empty muted", id "language-empty" ] [ text "No recorded playback in this scope yet. Try another person, device or date range." ]

              else
                div []
                    [ div [ class "language-distribution", attribute "role" "img", attribute "aria-label" ("Playback shares: " ++ String.join ", " (List.map (\( code, seconds ) -> languageName code ++ " " ++ percentLabel snapshot.seconds seconds) entries)) ]
                        (List.map
                            (\( language, seconds ) ->
                                div
                                    [ style "width" (String.fromFloat (percentage snapshot.seconds seconds) ++ "%")
                                    , style "background" (languageColor theme language)
                                    , title (languageName language ++ " · " ++ duration seconds ++ " · " ++ percentLabel snapshot.seconds seconds)
                                    ]
                                    []
                            )
                            entries
                        )
                    , div [ class "table-scroll" ]
                        [ table [ id "language-table" ]
                            [ thead [] [ tr [] [ th [ attribute "scope" "col" ] [ text "Language estimate" ], th [ attribute "scope" "col" ] [ text "Watch time" ], th [ attribute "scope" "col" ] [ text "Share" ], th [ attribute "scope" "col", class "language-bar-cell" ] [ text "Of all playback" ] ] ]
                            , tbody [] (List.map languageRow entries)
                            ]
                        ]
                    ]
            ]
        , section [ class "card language-contrast", id "language-contrast" ]
            [ div [ class "spread wrap" ]
                [ div [] [ span [ class "eyebrow" ] [ text "Put it in perspective" ], h3 [] [ text "One language vs. the rest" ] ]
                , select [ id "language-comparison", value model.comparison, onInput Compare, attribute "aria-label" "Language to compare" ] (List.map (\language -> option [ attribute "value" language, Html.Attributes.selected (model.comparison == language) ] [ text (languageName language) ]) languages)
                ]
            , div [ class "language-contrast-grid" ]
                [ div [ class "language-focus", style "border-color" (languageColor theme model.comparison) ]
                    [ span [ class "eyebrow" ] [ text (languageName model.comparison) ]
                    , strong [ class "language-share", id "language-focus-share" ] [ text (percentLabel snapshot.seconds selected) ]
                    , span [ class "figure", id "language-focus-time" ] [ text (duration selected) ]
                    ]
                , div [ class "language-rest" ]
                    [ span [ class "eyebrow" ] [ text "All other estimates" ]
                    , strong [ class "language-share", id "language-rest-share" ] [ text (percentLabel snapshot.seconds rest) ]
                    , span [ class "figure", id "language-rest-time" ] [ text (duration rest) ]
                    ]
                ]
            , p [ class "micro muted" ] [ text "The rest includes other and undetermined languages. Choosing a comparison does not filter or discard any playback." ]
            ]
        , section [ class "card language-explainer" ]
            [ h3 [] [ text "What these numbers mean" ]
            , p [ class "muted" ] [ text "Each watch segment keeps the language estimate recorded at the time. If the estimate changes during a video, its time can appear under more than one language. These are playback estimates, not verified spoken language or a measure of learning." ]
            , p [ class "micro muted" ] [ text "Includes on-tab and background playback, Videos and Shorts, and replays. Ads and pauses add no watch time. “Other / undetermined” includes unsupported languages and uncertain detections. This view uses the full selected range, independently of Observer’s history search, filters and pages." ]
            ]
        ]
