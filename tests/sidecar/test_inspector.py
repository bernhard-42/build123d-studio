"""The variable explorer's kernel half: what a row contains, and where it is.

This is the first test of `inspector`, which runs inside the kernel rather than
in the sidecar - so it is imported directly and handed a namespace, which is all
it ever reads. Everything it returns is a JSON string, deliberately, and these
parse it back: that round trip is part of what is being checked, because the
reason for the string is a printer on the far side that used to turn a long list
into a literal "..." and break every refresh from then on.

The example in the plan is the shape that mattered:

    a = dict(a=12, b="wert", c=[1,2,3,4,5,6], d=dict(x=dict(aa=1, bb="sdfg"), y=2))

Two levels of dict inside a dict inside a dict, which the pane could not reach
at all before: expanding a row showed one level of reprs and stopped.
"""

import json
import sys
import unittest

from build123d_studio import inspector

NESTED = dict(
    a=12,
    b="wert",
    c=[1, 2, 3, 4, 5, 6],
    d=dict(x=dict(aa=1, bb="sdfg"), y=2),
)


class _FakeShape:
    """A shape's surface, duck-typed - which is how the inspector reads one.

    Named rather than real because the inspector identifies a Face by its type
    name and must not import build123d to do it: that import costs over two
    seconds of loading OCCT and this module runs on every idle.
    """

    def __init__(self, kind, faces, edges, vertices):
        self.__class__ = type(kind, (_FakeShape,), {})
        self._counts = {"faces": faces, "edges": edges, "vertices": vertices}

    def faces(self):
        return [None] * self._counts["faces"]

    def edges(self):
        return [None] * self._counts["edges"]

    def vertices(self):
        return [None] * self._counts["vertices"]


class _Labelled:
    def __init__(self, label=None, name=None):
        if label is not None:
            self.label = label
        if name is not None:
            self.name = name


class _Assembly:
    """A build123d assembly's surface: a label, named children, and a topology.

    Duck-typed for the same reason _FakeShape is - the inspector must not import
    build123d - and the two collections differ on purpose, because that is the
    whole point: iterating gives one and .children gives the other.
    """

    def __init__(self, label, children, topology=None):
        self.label = label
        self.children = tuple(children)
        self._topology = list(topology or [])

    def __iter__(self):
        return iter(self._topology)

    def __len__(self):
        return len(self._topology)


class InspectorTest(unittest.TestCase):
    def setUp(self):
        # The inspector reads __main__'s namespace, which under unittest is the
        # runner's. Restored afterwards so one test cannot leak into another.
        self.namespace = sys.modules["__main__"].__dict__
        self.before = dict(self.namespace)
        self.addCleanup(self._restore)

    def _restore(self):
        self.namespace.clear()
        self.namespace.update(self.before)

    def given(self, **values):
        self.namespace.update(values)

    def detail(self, path, offset=0):
        return json.loads(inspector.detail(path, offset))

    def variables(self):
        return {row["name"]: row for row in json.loads(inspector.variables())}

    # --- what can be opened ---

    def test_only_rows_that_lead_somewhere_offer_to_open(self):
        """A chevron on an int is a promise the row cannot keep."""
        self.given(a_number=12, a_text="wert", a_list=[1, 2], an_empty=[], a_dict=NESTED)
        rows = self.variables()

        self.assertFalse(rows["a_number"]["expandable"])
        self.assertFalse(rows["a_text"]["expandable"])
        self.assertFalse(rows["an_empty"]["expandable"], "nothing inside it to show")
        self.assertTrue(rows["a_list"]["expandable"])
        self.assertTrue(rows["a_dict"]["expandable"])

    def test_deciding_that_never_touches_the_object(self):
        """Because it runs for every child of every expansion.

        A property that computes geometry would otherwise cost the whole pane
        rather than the one row somebody clicked.

        Asserted against _expandable rather than through variables(), because
        the listing does read one attribute deliberately: _size_of asks for
        .shape, which is how a numpy array reports its dimensions. That one is
        the documented exception and it is guarded; this is the rule.
        """
        touched = []

        class Watchful:
            def __getattr__(self, name):
                touched.append(name)
                raise AttributeError(name)

        inspector._expandable(Watchful())

        self.assertEqual(touched, [])

    # --- going down ---

    def test_the_first_level_of_a_dict(self):
        self.given(a=NESTED)
        children = self.detail(["a"])["children"]

        self.assertEqual([child["name"] for child in children], ["a", "b", "c", "d"])
        self.assertEqual([child["expandable"] for child in children], [False, False, True, True])

    def test_a_dict_inside_a_dict_inside_a_dict(self):
        """The plan's example, all the way down.

        Ordinals, not keys: "d" is the fourth entry of `a` and "x" is the first
        of that, so the path to `x` is ["a", 3, 0] - and `aa` is under it.
        """
        self.given(a=NESTED)

        x = self.detail(["a", 3, 0])
        self.assertEqual([child["name"] for child in x["children"]], ["aa", "bb"])

        # Where the path leads, asked of the walker the detail call uses. A
        # scalar has no expansion of its own - that is what makes it a leaf -
        # so the reply for one says nothing about its value.
        self.assertEqual(inspector._walk(self.namespace, ["a", 3, 0, 0]), 1)

    def test_a_list_inside_a_dict_is_indexed_by_position(self):
        self.given(a=NESTED)
        children = self.detail(["a", 2])["children"]

        self.assertEqual([child["name"] for child in children], ["0", "1", "2", "3", "4", "5"])
        self.assertEqual([child["repr"] for child in children], ["1", "2", "3", "4", "5", "6"])

    def test_a_key_that_has_no_faithful_text_form_still_addresses(self):
        """Which is the whole argument for ordinals.

        A tuple key, a Vector key, an object with a __repr__ of its own address
        - none of them survives a round trip through a path made of strings.
        """
        self.given(a={(1, 2): "corner", frozenset({3}): "edge"})
        children = self.detail(["a"])["children"]

        self.assertEqual(len(children), 2)
        self.assertEqual(inspector._walk(self.namespace, ["a", 0]), "corner")
        self.assertEqual(inspector._walk(self.namespace, ["a", 1]), "edge")

    def test_a_set_can_be_opened_even_though_it_has_no_order_of_its_own(self):
        self.given(a={"one", "two", "three"})
        children = self.detail(["a"])["children"]

        self.assertEqual(len(children), 3)
        # Whatever order the set gives, the ordinals must agree with it - or a
        # child's own row and the row it opens describe different objects. The
        # listing and the walk are two separate enumerations of the same set,
        # which is exactly what could disagree.
        for index, child in enumerate(children):
            walked = inspector._walk(self.namespace, ["a", index])
            self.assertEqual(inspector._short_repr(walked), child["repr"])

    # --- paging ---

    def test_a_long_list_arrives_one_page_at_a_time(self):
        self.given(points=list(range(5043)))
        first = self.detail(["points"])

        self.assertEqual(len(first["children"]), inspector.PAGE)
        self.assertEqual(first["offset"], 0)
        self.assertEqual(first["total"], 5043)
        self.assertEqual(first["children"][0]["name"], "0")

    def test_a_later_page_is_numbered_from_where_it_starts(self):
        """The names are absolute positions, so a child's path is its ordinal.

        Numbered from zero within the page instead, every page after the first
        would open the wrong element.
        """
        self.given(points=list(range(5043)))
        page = self.detail(["points"], 5000)

        self.assertEqual(page["children"][0]["name"], "5000")
        self.assertEqual(len(page["children"]), 43)
        self.assertEqual(inspector._walk(self.namespace, ["points", 5000]), 5000)

    def test_the_page_size_travels_with_the_page(self):
        """So the pane can work out the previous page's offset.

        The last page is short, so the number of children in hand is the right
        step forwards and the wrong one back.
        """
        self.given(points=list(range(5043)))

        self.assertEqual(self.detail(["points"])["page"], inspector.PAGE)

    def test_a_huge_dict_is_not_materialised_to_reach_one_page(self):
        """islice rather than list(): a mesh's worth of entries is realistic.

        Asserted by the count of items the mapping was asked for, which is what
        a full materialisation would blow up.
        """
        seen = []

        class Counting(dict):
            def items(self):
                for key, value in super().items():
                    seen.append(key)
                    yield key, value

        self.given(big=Counting({f"k{n}": n for n in range(10000)}))
        page = self.detail(["big"], 200)

        self.assertEqual(len(page["children"]), inspector.PAGE)
        self.assertLess(len(seen), 400, "the whole dict was walked for one page")

    # --- the repr column ---

    def test_a_container_that_unrolls_shows_no_repr(self):
        """The expansion is its contents; the column would say it twice.

        The column is needed for the rows where opening the object is not an
        option, and a list of six numbers repeated underneath itself is exactly
        the noise that leaves no room for them.
        """
        self.given(numbers=[1, 2, 3, 4, 5, 6], mapping={"a": 1}, shape="not a container")
        rows = self.variables()

        self.assertEqual(rows["numbers"]["repr"], "")
        self.assertEqual(rows["mapping"]["repr"], "")
        self.assertEqual(rows["shape"]["repr"], "'not a container'")

    def test_an_empty_container_still_shows_one(self):
        """It has nothing to unroll into, so the repr is all it will ever say."""
        self.given(nothing=[], empty_map={})
        rows = self.variables()

        self.assertEqual(rows["nothing"]["repr"], "[]")
        self.assertEqual(rows["empty_map"]["repr"], "{}")

    def test_children_follow_the_same_rule(self):
        self.given(a=NESTED)
        children = {child["name"]: child for child in self.detail(["a"])["children"]}

        self.assertEqual(children["a"]["repr"], "12")
        self.assertEqual(children["c"]["repr"], "", "a list that unrolls")
        self.assertEqual(children["d"]["repr"], "", "a dict that unrolls")

    def test_a_broken_repr_costs_its_own_row_and_no_more(self):
        """reprlib substitutes its own text when __repr__ raises."""
        class Awkward:
            def __repr__(self):
                raise ValueError("no")

        self.given(awkward=Awkward())

        self.assertIn("Awkward", self.variables()["awkward"]["repr"])

    # --- what is data and what is code ---

    def test_classes_and_functions_are_not_variables(self):
        """This pane answers "what is in my model now".

        A class definition is part of the code rather than part of the answer,
        and a file with a few helpers and a couple of shape classes pushed the
        shapes off the top of the pane with rows that never change.
        """
        source = "class Cube:\n    pass\n\ndef helper(x):\n    return x\n\nsize = 12\n"
        exec(source, self.namespace)  # noqa: S102 - defining the thing under test
        rows = self.variables()

        self.assertIn("size", rows)
        self.assertNotIn("Cube", rows)
        self.assertNotIn("helper", rows)

    def test_nor_is_a_lambda_or_an_instance_method(self):
        self.given(twice=lambda x: x * 2, method="".join)
        rows = self.variables()

        self.assertNotIn("twice", rows)
        self.assertNotIn("method", rows)

    def test_but_an_instance_of_a_user_class_is(self):
        """Which is the point of the distinction: the class is code, the object
        it made is what the run produced."""
        exec("class Cube:\n    pass\n\nc = Cube()\n", self.namespace)  # noqa: S102

        self.assertIn("c", self.variables())

    # --- every Iterable unrolls, with two exceptions ---

    def test_an_iterable_of_somebody_else_s_making_unrolls(self):
        """The general rule: __iter__ and __len__ is all it takes.

        A list, a dict and a set were special-cased before, which meant a numpy
        array, a range, a ShapeList or a user's own collection showed one line
        of repr and no way in.
        """
        class Bag:
            def __init__(self, items):
                self._items = items

            def __iter__(self):
                return iter(self._items)

            def __len__(self):
                return len(self._items)

        self.given(bag=Bag(["x", "y", "z"]), numbers=range(5))
        rows = self.variables()

        self.assertTrue(rows["bag"]["expandable"])
        self.assertTrue(rows["numbers"]["expandable"])
        self.assertEqual(
            [child["repr"] for child in self.detail(["bag"])["children"]],
            ["'x'", "'y'", "'z'"],
        )
        self.assertEqual(self.detail(["numbers"])["total"], 5)

    def test_a_generator_is_never_unrolled_because_looking_would_consume_it(self):
        """The one way this pane could damage a session rather than misreport it.

        Iterator rather than Generator, and the difference is not academic: zip,
        map, filter, enumerate, iter(list), an open file and reversed() are all
        consumed by iteration and not one of them is a Generator.
        """
        numbers = [1, 2, 3]
        self.given(
            generated=(n for n in numbers),
            zipped=zip(numbers, numbers, strict=True),
            mapped=map(str, numbers),
            walked=iter(numbers),
        )
        rows = self.variables()

        for name in ("generated", "zipped", "mapped", "walked"):
            with self.subTest(name=name):
                self.assertFalse(rows[name]["expandable"], "offering to open it consumes it")
                self.assertNotIn("children", self.detail([name]))

        # And the proof that matters: still all there afterwards.
        self.assertEqual(list(self.namespace["generated"]), [1, 2, 3])
        self.assertEqual(list(self.namespace["zipped"]), [(1, 1), (2, 2), (3, 3)])

    def test_a_string_is_not_five_rows_of_one_character(self):
        """str and bytes are Iterable and Sized, and neither is what was meant."""
        self.given(word="hello", raw=b"hi")
        rows = self.variables()

        self.assertFalse(rows["word"]["expandable"])
        self.assertFalse(rows["raw"]["expandable"])

    def test_an_iterable_with_no_length_keeps_the_attribute_view(self):
        """Paging needs a total and a total needs a length.

        Measured against build123d, this is Vector and Location. It also excludes
        the endless ones - itertools.count() is Iterable, and asking it how many
        would never come back.
        """
        class Endless:
            def __iter__(self):
                while True:
                    yield 1

        self.given(endless=Endless())

        self.assertNotIn("children", self.detail(["endless"]))

    def test_an_object_that_both_unrolls_and_has_attributes_gives_both(self):
        """A build123d Part is Iterable and Sized *and* has the shape counts.

        Choosing between them would mean that making shapes iterable quietly
        took away the faces, edges and vertices this pane has always shown.
        """
        class Shape(list):
            def faces(self):
                return [1, 2, 3, 4, 5, 6]

        # Not a plain container, so both halves apply: it subclasses list but is
        # asked for its shape facts as well.
        self.given(part=Shape(["a solid"]))
        opened = self.detail(["part"])

        self.assertEqual([child["repr"] for child in opened["children"]], ["'a solid'"])

    def test_a_hostile_iterable_costs_its_own_row(self):
        class Hostile:
            def __iter__(self):
                raise RuntimeError("no")

            def __len__(self):
                return 3

        self.given(hostile=Hostile())

        self.assertNotIn("children", self.detail(["hostile"]))

    # --- shape facts, and how much room they get ---

    def test_the_counts_are_one_row_rather_than_three(self):
        """Because they sit between the object and what it was opened to show.

        Once shapes unrolled into their contents, three keyed rows meant three
        lines of scrolling past known facts to reach the children, every time.
        Read together they also say more: "6 faces, 12 edges, 8 vertices" is a
        box at a glance, where the same numbers stacked are three facts to
        assemble.
        """
        self.given(solid=_FakeShape("Solid", faces=6, edges=12, vertices=8))
        attributes = self.detail(["solid"])["attributes"]

        self.assertEqual(attributes, {"topology": "6 faces, 12 edges, 8 vertices"})

    def test_a_face_is_not_told_that_it_has_one_face(self):
        """Its own definition fixes that, so the count says nothing."""
        self.given(f=_FakeShape("Face", faces=1, edges=4, vertices=4))

        self.assertEqual(self.detail(["f"])["attributes"], {"topology": "4 edges, 4 vertices"})

    def test_an_edge_is_told_nothing_at_all(self):
        """One edge, two vertices, no faces - all three known in advance."""
        self.given(e=_FakeShape("Edge", faces=0, edges=1, vertices=2))

        self.assertEqual(self.detail(["e"])["attributes"], {})

    # --- labels ---

    def test_a_label_is_shown_beside_the_name(self):
        """The only thing that tells one Face from another.

        A list of six otherwise reads as six lines of "<Face object at 0x…>",
        which is the address of a thing rather than the thing.
        """
        self.given(top=_Labelled(label="top"))

        self.assertEqual(self.variables()["top"]["label"], "top")

    def test_name_answers_where_there_is_no_label(self):
        """Enum members and open files carry it in the same spirit."""
        self.given(thing=_Labelled(name="mounting hole"))

        self.assertEqual(self.variables()["thing"]["label"], "mounting hole")

    def test_an_empty_label_is_no_label(self):
        """build123d gives every shape a label and most of them are "" ."""
        self.given(bare=_Labelled(label="", name=""))

        self.assertEqual(self.variables()["bare"]["label"], "")

    def test_a_long_label_is_cut(self):
        self.given(wordy=_Labelled(label="x" * 200))
        shown = self.variables()["wordy"]["label"]

        self.assertLessEqual(len(shown), inspector.MAX_LABEL)
        self.assertTrue(shown.endswith("…"))

    def test_a_label_that_objects_to_being_read_costs_nothing(self):
        class Awkward:
            @property
            def label(self):
                raise RuntimeError("no")

        self.given(awkward=Awkward())

        self.assertEqual(self.variables()["awkward"]["label"], "")

    def test_children_carry_their_labels_too(self):
        """Which is where it matters most: the row is called "0"."""
        self.given(faces=[_Labelled(label="top"), _Labelled(label="bottom")])
        children = self.detail(["faces"])["children"]

        self.assertEqual([child["label"] for child in children], ["top", "bottom"])

    # --- assemblies unroll by their children ---

    def test_an_assembly_unrolls_into_the_parts_somebody_named(self):
        """Not into its topology, which is what iterating one gives.

        Measured on a real build123d assembly: iter(compound) yields unlabelled
        Compound wrappers, and .children yields the objects the user built and
        named. The second is what the viewer's own tree shows, and it is the
        only one of the two that carries the labels.
        """
        leg = _Assembly("left_middle_leg", [_Labelled(label="upper_leg"),
                                            _Labelled(label="lower_leg")])
        self.given(hexapod=_Assembly("hexapod", [_Labelled(label="bottom"), leg]))

        children = self.detail(["hexapod"])["children"]
        self.assertEqual([child["label"] for child in children], ["bottom", "left_middle_leg"])

    def test_and_keeps_doing_it_all_the_way_down(self):
        """hexapod > left_middle_leg > upper_leg, by name at every level."""
        leg = _Assembly("left_middle_leg", [_Labelled(label="upper_leg")])
        self.given(hexapod=_Assembly("hexapod", [_Labelled(label="bottom"), leg]))

        grandchildren = self.detail(["hexapod", 1])["children"]
        self.assertEqual([child["label"] for child in grandchildren], ["upper_leg"])
        self.assertEqual(inspector._walk(self.namespace, ["hexapod", 1, 0]).label, "upper_leg")

    def test_a_shape_with_no_children_falls_through_to_its_topology(self):
        """Every build123d shape has a `children`, and for most it is empty."""
        self.given(solid=_Assembly("solid", [], topology=["a face", "another"]))
        children = self.detail(["solid"])["children"]

        self.assertEqual([child["repr"] for child in children], ["'a face'", "'another'"])

    def test_a_children_attribute_that_is_not_a_collection_is_ignored(self):
        """`children` is a common enough name to belong to something else."""
        class Odd:
            children = 12

            def __iter__(self):
                return iter(["real"])

            def __len__(self):
                return 1

        self.given(odd=Odd())

        self.assertEqual([c["repr"] for c in self.detail(["odd"])["children"]], ["'real'"])

    # --- paths that no longer lead anywhere ---

    def test_a_variable_that_has_gone(self):
        self.assertEqual(self.detail(["never_defined"])["error"], "no longer defined")

    def test_a_child_that_has_gone(self):
        """The namespace is re-read after every execution, and lists shrink."""
        self.given(shrinking=[1, 2, 3])
        self.namespace["shrinking"] = [1]

        self.assertIn("error", self.detail(["shrinking", 2]))

    def test_an_object_that_objects_to_being_walked(self):
        class Hostile(list):
            def __getitem__(self, index):
                raise RuntimeError("no")

        self.given(hostile=Hostile([1, 2, 3]))

        self.assertIn("error", self.detail(["hostile", 0]))

    def test_an_empty_path_is_answered_rather_than_raised(self):
        self.assertIn("error", self.detail([]))


if __name__ == "__main__":
    unittest.main()
